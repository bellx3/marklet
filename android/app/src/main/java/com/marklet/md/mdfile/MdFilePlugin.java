package com.marklet.md.mdfile;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 자체 파일 접근 플러그인. 이 앱의 심장이다.
 *
 * 왜 직접 만드는가 (06_조사_파일처리.md 에서 바이트코드까지 열어 확인한 것):
 *   1. @capacitor/filesystem 은 content:// 에 **쓸 수 없다.** saveFile 자체가 없다.
 *   2. @capawesome/capacitor-file-picker 는 **영속 권한을 못 준다.**
 *      ACTION_GET_CONTENT 를 쓰고 takePersistableUriPermission 호출이 한 번도 없다.
 *   3. Capacitor 의 인텐트 처리는 ACTION_SEND 를 버리고,
 *      Bridge.intentUri 는 생성자에서만 설정되어 두 번째 파일부터 낡은 값을 준다.
 */
@CapacitorPlugin(name = "MdFile")
public class MdFilePlugin extends Plugin {

    private static final String TAG = "MdFile";

    /** 읽기라도 시도할 최대 크기. 앱 로직의 렌더 상한(4MB)과 다르다. */
    private static final long MAX_BYTES = 8L * 1024 * 1024;

    /** 콜드 스타트로 받은 URI. JS가 getPendingOpen()으로 한 번 가져가면 비운다. */
    private Uri pendingUri;
    /** ACTION_SEND로 파일이 아닌 '텍스트'가 공유된 경우. */
    private String pendingText;
    /**
     * JS가 getPendingOpen()을 한 번이라도 불렀는지.
     * ★★ 이게 없으면 콜드 스타트에서 문서가 **두 번** 열린다. 아래 captureIntent 주석 참고.
     */
    private boolean pendingConsumed = false;

    // ────────────────────────────────────────────────────────────
    // 인텐트 수신
    // ────────────────────────────────────────────────────────────

    @Override
    public void load() {
        super.load();
        // 콜드 스타트: 액티비티를 띄운 인텐트를 여기서 붙잡는다.
        // @capacitor/app 의 getLaunchUrl()은 ACTION_SEND를 못 받으므로 직접 처리한다.
        captureIntent(getActivity().getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        // 앱이 이미 떠 있는 상태에서 새 파일이 들어온 경우.
        captureIntent(intent, true);
    }

    /**
     * @param notify 호출자가 '앱 실행 중'이라고 주장하는지. **그대로 믿으면 안 된다** — 아래 참고.
     *
     * ★★ 콜드 스타트에서 이 메서드는 **두 번** 불린다 (Capacitor 8.5.0 실측, 2026-08-03).
     *   BridgeActivity.load() 가 onCreate 안에서 `this.onNewIntent(getIntent())` 를
     *   직접 부르기 때문이다(BridgeActivity.java:51). 그래서 순서가 이렇게 된다:
     *     1) Plugin.load()          → captureIntent(intent, false) → pendingUri 보관
     *     2) handleOnNewIntent()    → captureIntent(intent, true)  → mdFileOpen 이벤트(retain)
     *   JS 쪽은 5-4절대로 리스너를 먼저 붙이고 getPendingOpen() 을 부르므로
     *   **보관됐던 이벤트와 pending 을 둘 다 받아 같은 문서를 두 번 연다.**
     *   실측 로그: 탭 한 번에 read 호출이 callbackId 12435798, 12435799 로 두 번.
     *
     *   그래서 notify 는 'JS 가 아직 콜드 스타트 몫을 가져가지 않았는가'로 한 번 더 거른다.
     *   가져가기 전이면 이벤트를 쏘지 않고 보관분만 갈아끼운다.
     */
    private void captureIntent(Intent intent, boolean notify) {
        if (intent == null) return;

        String action = intent.getAction();
        Uri uri = null;
        String sharedText = null;

        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = getStreamExtra(intent);
            if (uri == null) {
                // 파일이 아니라 순수 텍스트를 공유한 경우 (예: 메모 앱에서 텍스트 공유)
                CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (cs != null) sharedText = cs.toString();
            }
        }

        if (uri == null && sharedText == null) return;

        // 중요: 액티비티의 현재 인텐트를 갱신해 둔다.
        // 이렇게 해야 이후 회전/복원 시 getIntent()가 옛 인텐트를 돌려주지 않는다.
        if (notify) getActivity().setIntent(intent);

        Log.i(TAG, "captureIntent action=" + action + " uri=" + uri
                + " mime=" + (uri != null ? safeType(getContext().getContentResolver(), uri) : "-"));

        // JS 가 아직 콜드 스타트 몫을 가져가지 않았다 = 지금은 부팅 중이다.
        // 이벤트로 쏘지 말고 보관분만 최신으로 갈아끼운다.
        // (부팅 중에 사용자가 다른 파일을 또 골랐다면 나중 것이 이긴다 — 그게 사용자가 마지막에 원한 것이다.)
        if (!pendingConsumed) {
            pendingUri = uri;
            pendingText = sharedText;
            return;
        }

        if (notify) {
            JSObject ev = (uri != null) ? describe(uri) : new JSObject();
            if (sharedText != null) ev.put("sharedText", sharedText);
            // 두 번째 인자 true = 리스너가 아직 없으면 붙을 때까지 보관(retain)
            notifyListeners("mdFileOpen", ev, true);
        } else {
            pendingUri = uri;
            pendingText = sharedText;
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri getStreamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /** 콜드 스타트로 들어온 문서를 JS가 가져간다. 한 번 가져가면 비워진다. */
    @PluginMethod
    public void getPendingOpen(PluginCall call) {
        JSObject ret = new JSObject();
        if (pendingUri != null) {
            ret = describe(pendingUri);
            pendingUri = null;
        }
        if (pendingText != null) {
            ret.put("sharedText", pendingText);
            pendingText = null;
        }
        // ★ 여기부터는 새 인텐트를 이벤트로 쏜다. 이 줄이 콜드 스타트와 실행 중을 가르는 경계다.
        //   문서가 없어서 빈 객체를 돌려주는 경우에도 반드시 세워야 한다 —
        //   아이콘으로 실행한 뒤 파일을 여는 게 가장 흔한 경로다.
        pendingConsumed = true;
        call.resolve(ret);
    }

    // ────────────────────────────────────────────────────────────
    // 읽기
    // ────────────────────────────────────────────────────────────

    @PluginMethod
    public void read(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("uri가 필요합니다", "EINVAL"); return; }

        Uri uri = Uri.parse(uriStr);
        ContentResolver cr = getContext().getContentResolver();

        try (InputStream is = cr.openInputStream(uri)) {
            if (is == null) { call.reject("파일을 열 수 없습니다", "ENOENT"); return; }

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = is.read(buf)) != -1) {
                total += n;
                if (total > MAX_BYTES) { call.reject("파일이 너무 큽니다", "ETOOBIG"); return; }
                bos.write(buf, 0, n);
            }

            byte[] bytes = bos.toByteArray();
            TextDecoding.Result decoded = TextDecoding.decode(bytes);
            if (!"UTF-8".equals(decoded.charset)) {
                Log.i(TAG, "UTF-8 디코딩 실패율이 높아 " + decoded.charset + " 로 폴백했다");
            }

            JSObject ret = describe(uri);
            ret.put("content", decoded.text);
            ret.put("encoding", decoded.charset);   // JS 가 안내 문구를 띄우는 데 쓴다
            call.resolve(ret);

        } catch (IOException | RuntimeException e) {
            /*
             * ★★ 분류를 여기서 짓지 말고 UriErrors 로 보낸다 — 여기 적으면 기기 없이는
             *   한 줄도 시험할 수 없다(TextDecoding 을 떼어 낸 이유와 같다, 14-1절).
             *
             * ★ 예전에는 SecurityException 만 따로 잡고 나머지를 전부 EIO 로 보냈다.
             *   그런데 **없어진 파일은 FileNotFoundException 으로 온다.** 그래서
             *   위쪽 `is == null` 의 ENOENT 분기는 사실상 죽은 코드였고,
             *   JS 의 "파일을 찾을 수 없습니다. 이동되거나 삭제된 것 같습니다." 도
             *   영영 뜨지 않았다. 가장 흔한 실패인데 가장 알 수 없는 문장이 떴다.
             */
            String code = UriErrors.codeOf(e);
            call.reject(readErrorMessage(code, e), code, e);
        }
    }

    /** 화면 문구는 JS 가 만든다. 여기 문장은 로그와 폴백용이다. */
    private static String readErrorMessage(String code, Throwable e) {
        switch (code) {
            case UriErrors.EPERM:
                return "이 파일에 접근할 권한이 없습니다";
            case UriErrors.ENOENT:
                return "파일을 찾을 수 없습니다";
            default:
                return String.valueOf(e.getMessage());
        }
    }


    // ────────────────────────────────────────────────────────────
    // 쓰기  ← @capacitor/filesystem 이 못 하는 부분
    // ────────────────────────────────────────────────────────────

    @PluginMethod
    public void write(PluginCall call) {
        String uriStr = call.getString("uri");
        String content = call.getString("content");
        if (uriStr == null || content == null) {
            call.reject("uri와 content가 필요합니다", "EINVAL");
            return;
        }

        Uri uri = Uri.parse(uriStr);
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        ContentResolver cr = getContext().getContentResolver();

        ParcelFileDescriptor pfd = null;
        try {
            // "rwt" = read-write-truncate. 기존 내용을 확실히 지우고 쓴다.
            // "w"로만 열면 새 내용이 더 짧을 때 뒤에 옛 내용이 남는다.
            // (5000자 문서를 100자로 줄여 저장하면 뒤에 4900자가 그대로 남는 사고)
            try {
                pfd = cr.openFileDescriptor(uri, "rwt");
            } catch (Exception noTruncate) {
                // 일부 프로바이더(클라우드 계열)는 "rwt"를 지원하지 않는다.
                Log.w(TAG, "rwt 미지원, w로 재시도: " + noTruncate.getMessage());
                pfd = cr.openFileDescriptor(uri, "w");
            }

            if (pfd == null) { call.reject("쓰기용으로 열 수 없습니다", "EACCES"); return; }

            FileOutputStream fos = new FileOutputStream(pfd.getFileDescriptor());
            try {
                // "w"로 열렸을 경우를 대비해 명시적으로 잘라낸다.
                fos.getChannel().truncate(0);
            } catch (IOException truncErr) {
                Log.w(TAG, "truncate 미지원: " + truncErr.getMessage());
            }

            fos.write(data);
            fos.flush();

            try {
                // 디스크까지 확실히 내려보낸다. 여기서 실패해도 치명적이지 않다.
                pfd.getFileDescriptor().sync();
            } catch (Exception syncErr) {
                Log.w(TAG, "sync 미지원(클라우드 프로바이더일 수 있음): " + syncErr.getMessage());
            }
            // ★ 주의: fos.close()를 부르지 않는다. fos를 닫으면 pfd의 FD가 함께 닫혀
            //   아래 pfd.close()가 예외를 던진다. FD 소유권은 pfd에 있다.

            /*
             * ★★ close를 finally에 미루고 먼저 resolve하지 마라.
             *   프로바이더에 따라 **실제 커밋이 close 시점에** 일어난다(클라우드 계열).
             *   거기서 실패하는데 JS가 이미 "성공"을 받았으면, 저장되지 않은 문서를
             *   저장됐다고 알리게 된다 — 이 앱에서 제일 하면 안 되는 거짓말이다.
             *   여기서 닫고, 닫히는 것까지 확인한 뒤에 성공을 알린다.
             *
             * ★ close가 실패해도 사용자의 문서는 안전하다. JS가 쓰기 전에 백업을 받아 두고
             *   (services/save.ts 2단계), 실패하면 [백업 내용 보기]·[새 이름으로 저장]을 준다.
             */
            pfd.close();
            pfd = null;

            JSObject ret = new JSObject();
            ret.put("bytesWritten", data.length);
            ret.put("uri", uri.toString());
            call.resolve(ret);

        } catch (IOException | RuntimeException e) {
            // ★ 읽기와 같은 분류를 쓴다. 지워진 파일에 저장하는 것은 EIO('저장 공간을
            //   확인해 주세요')가 아니다 — 사용자가 할 일이 완전히 다르다.
            String code = UriErrors.codeOf(e);
            call.reject(writeErrorMessage(code, e), code, e);
        } finally {
            if (pfd != null) {
                try { pfd.close(); } catch (IOException ignored) { }
            }
        }
    }

    private static String writeErrorMessage(String code, Throwable e) {
        switch (code) {
            case UriErrors.EPERM:
                return "이 파일에 쓸 권한이 없습니다";
            case UriErrors.EREADONLY:
                return "이 위치에는 저장할 수 없습니다";
            case UriErrors.ENOENT:
                return "저장할 파일이 없습니다";
            default:
                return String.valueOf(e.getMessage());
        }
    }

    // ────────────────────────────────────────────────────────────
    // SAF 파일 선택 (ACTION_OPEN_DOCUMENT) + 영속 권한
    // ────────────────────────────────────────────────────────────

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // setType은 넓게, EXTRA_MIME_TYPES로 좁힌다.
        // octet-stream을 넣어야 카카오톡/Drive에서 받은 md가 목록에 뜬다.
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/markdown",
                "text/x-markdown",
                "text/plain",
                "application/octet-stream"
        });
        // 이 세 플래그가 있어야 나중에 takePersistableUriPermission이 성공한다.
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }

        Uri uri = data.getData();
        boolean persisted = persist(uri, data.getFlags());

        JSObject ret = describe(uri);
        ret.put("cancelled", false);
        ret.put("persisted", persisted);
        call.resolve(ret);
    }

    // ────────────────────────────────────────────────────────────
    // SAF 폴더 선택 (ACTION_OPEN_DOCUMENT_TREE)
    // ────────────────────────────────────────────────────────────

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }

        Uri tree = data.getData();
        boolean persisted = persist(tree, data.getFlags());

        JSObject ret = new JSObject();
        ret.put("cancelled", false);
        ret.put("uri", tree.toString());
        ret.put("persisted", persisted);
        ret.put("name", treeDisplayName(tree));
        call.resolve(ret);
    }

    /** 폴더 안의 마크다운 파일 목록. 하위 폴더는 depth 제한으로 재귀 탐색한다. */
    @PluginMethod
    public void listFolder(PluginCall call) {
        String uriStr = call.getString("uri");
        int maxDepth = call.getInt("maxDepth", 3);
        if (uriStr == null) { call.reject("uri가 필요합니다", "EINVAL"); return; }

        Uri tree = Uri.parse(uriStr);
        try {
            String rootDocId = DocumentsContract.getTreeDocumentId(tree);
            Scan scan = new Scan();
            walk(tree, rootDocId, 0, maxDepth, scan);

            JSArray arr = new JSArray();
            for (JSObject o : scan.out) arr.put(o);

            JSObject ret = new JSObject();
            ret.put("files", arr);
            /*
             * ★★ 잘렸으면 반드시 알린다. 예전에는 조용히 멈췄다 —
             *   사용자는 폴더에 파일이 더 있는데 목록에 없는 것을 보고
             *   "이 앱이 내 파일을 못 찾는다" 고 판단한다. 원인은 화면 어디에도 안 남는다.
             */
            ret.put("truncated", scan.truncated);
            ret.put("limit", MAX_FILES);
            // ★ 깊이 상한도 같은 이유로 알린다(Scan.depthLimited 주석).
            ret.put("depthLimited", scan.depthLimited);
            ret.put("maxDepth", maxDepth);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject("폴더 권한이 만료되었습니다", "EPERM", e);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "EIO", e);
        }
    }

    /**
     * 한 폴더에서 가져올 파일 수의 상한.
     *
     * ★ 이걸 넘기면 목록 화면이 감당하지 못한다(항목 하나마다 DOM 노드가 여럿이다).
     *   그리고 SAF 커서 순회 자체가 느려져 시작 화면이 몇 초씩 멎는다.
     */
    private static final int MAX_FILES = 2000;

    /** 훑기 결과. 목록과 '잘렸는가'를 함께 들고 다닌다. */
    private static final class Scan {
        final List<JSObject> out = new ArrayList<>();
        boolean truncated = false;
        /**
         * ★★ 깊이 상한에 걸려 **들여다보지 않은 하위 폴더가 있었는가.**
         *   개수 상한(MAX_FILES)은 알려 주면서 깊이 상한은 조용히 넘어가고 있었다.
         *   증상은 똑같다 — 사용자는 폴더에 있는 파일이 목록에 없는 것을 보고
         *   "이 앱이 내 파일을 못 찾는다" 고 판단한다. 원인은 화면 어디에도 안 남는다.
         *   옵시디언처럼 폴더를 겹겹이 쓰는 사람이 바로 걸린다.
         */
        boolean depthLimited = false;
    }

    private void walk(Uri tree, String docId, int depth, int maxDepth, Scan scan) {
        if (depth > maxDepth || scan.truncated) return;

        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] proj = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };

        try (Cursor c = getContext().getContentResolver()
                .query(children, proj, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                /*
                 * ★★ 상한 검사가 여기 있어야 한다. 예전에는 walk() 진입 시점에만 봤는데,
                 *   그러면 **평평한 폴더에서는 아예 안 걸린다** — 하위 폴더가 없으면
                 *   walk() 가 한 번만 불리고 이 while 문이 파일 1만 개를 그대로 다 담는다.
                 *   그게 가장 흔한 모양이다(다운로드 폴더, 문서 폴더).
                 */
                if (scan.out.size() >= MAX_FILES) {
                    scan.truncated = true;
                    return;
                }

                String childId = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    // ★ '들어가지 않았다'는 사실을 여기서 남긴다. 진입 시점의 depth 검사로는
                    //   '하위 폴더가 있었는지' 자체를 알 수 없어 알려 줄 방법이 없다.
                    if (depth + 1 > maxDepth) {
                        scan.depthLimited = true;
                        continue;
                    }
                    walk(tree, childId, depth + 1, maxDepth, scan);
                    if (scan.truncated) return;
                    continue;
                }
                if (!isMarkdownName(name)) continue;

                JSObject o = new JSObject();
                o.put("uri", DocumentsContract
                        .buildDocumentUriUsingTree(tree, childId).toString());
                o.put("name", name);
                o.put("mimeType", mime);
                o.put("size", c.isNull(3) ? -1 : c.getLong(3));
                o.put("lastModified", c.isNull(4) ? 0 : c.getLong(4));
                scan.out.add(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "폴더 탐색 실패 docId=" + docId + " : " + e.getMessage());
        }
    }

    /** 폴더 목록에서는 MIME을 믿을 수 없으므로 파일 이름으로 거른다. */
    private static boolean isMarkdownName(String name) {
        if (name == null) return false;
        String n = name.toLowerCase();
        return n.endsWith(".md") || n.endsWith(".markdown")
                || n.endsWith(".mdown") || n.endsWith(".mkd") || n.endsWith(".txt");
    }

    // ────────────────────────────────────────────────────────────
    // 영속 권한 관리
    // ────────────────────────────────────────────────────────────

    /**
     * 권한을 영구 보관한다. 이게 없으면 앱을 껐다 켠 뒤 URI가 무효가 된다.
     * @capawesome/capacitor-file-picker 가 빠뜨린 바로 그 호출이다.
     */
    private boolean persist(Uri uri, int grantFlags) {
        int take = grantFlags
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (take == 0) take = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, take);
            return true;
        } catch (SecurityException e) {
            // ACTION_SEND/ACTION_VIEW로 받은 URI는 대개 영속화가 불가능하다. 정상 상황이다.
            Log.w(TAG, "영속 권한 불가: " + uri + " (" + e.getMessage() + ")");
            return false;
        }
    }

    /** 현재 앱이 들고 있는 영속 권한 전체. 앱 시작 시 최근 목록과 대조한다. */
    @PluginMethod
    public void getPersistedUris(PluginCall call) {
        JSArray arr = new JSArray();
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            JSObject o = new JSObject();
            o.put("uri", p.getUri().toString());
            o.put("read", p.isReadPermission());
            o.put("write", p.isWritePermission());
            o.put("persistedTime", p.getPersistedTime());
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("uris", arr);
        call.resolve(ret);
    }

    /** 최근 목록에서 지울 때 권한도 같이 반납한다. 상한에 걸리지 않게 하는 위생 작업. */
    @PluginMethod
    public void releaseUri(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) { call.reject("uri가 필요합니다", "EINVAL"); return; }
        try {
            getContext().getContentResolver().releasePersistableUriPermission(
                    Uri.parse(uriStr),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            Log.w(TAG, "권한 반납 실패(이미 없을 수 있음): " + e.getMessage());
        }
        call.resolve();
    }

    // ────────────────────────────────────────────────────────────
    // 새 이름으로 저장 (ACTION_CREATE_DOCUMENT)
    // ────────────────────────────────────────────────────────────

    /** 원본이 읽기 전용일 때의 탈출구. 저장 실패 시 반드시 이 경로를 제공해야 한다. */
    @PluginMethod
    public void createFile(PluginCall call) {
        String suggestedName = call.getString("name", "untitled.md");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/markdown");
        intent.putExtra(Intent.EXTRA_TITLE, suggestedName);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "createFileResult");
    }

    @ActivityCallback
    private void createFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = data.getData();
        boolean persisted = persist(uri, data.getFlags());
        JSObject ret = describe(uri);
        ret.put("cancelled", false);
        ret.put("persisted", persisted);
        call.resolve(ret);
    }

    // ────────────────────────────────────────────────────────────
    // 파일 공유 (5-8절)
    // ────────────────────────────────────────────────────────────

    /**
     * 원본 content:// URI 를 그대로 EXTRA_STREAM 으로 재위임해 **파일 자체**를 공유한다.
     *
     * ★ 왜 @capacitor/share 를 쓰지 않는가 (플러그인 소스로 확인, 2026-08-04):
     *   SharePlugin.shareFiles() 는 file:// 만 받고, 그렇지 않으면
     *   "only file urls are supported" 로 reject 한다. 게다가 내부에서
     *   FileProvider.getUriForFile(packageName + ".fileprovider", ...) 을 부르므로
     *   **FileProvider 선언이 필수**다. 우리는 사용자의 파일을 앱 안에 복사해 두지 않으므로
     *   그 경로 자체가 맞지 않는다 — 우리가 가진 건 남의 프로바이더가 준 content:// 다.
     *
     * ★★ setClipData 를 빼지 마라. Android 10+ 에서는 ClipData 에 URI 가 들어 있어야
     *   FLAG_GRANT_READ_URI_PERMISSION 이 받는 앱까지 전달된다. EXTRA_STREAM 에만 넣으면
     *   상대 앱이 "권한 없음"으로 파일을 못 읽는다.
     *
     * @param mimeType 실험 대상이다. text/markdown 은 text/* 라 메신저가 스트림을 읽어
     *                 **텍스트로 바꿔 보내는** 경우가 있다(5-8절 실측). 그때는 호출부가
     *                 application/octet-stream 으로 다시 부른다.
     */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("공유할 파일이 없습니다.", "ENOURI");
            return;
        }
        Uri source = Uri.parse(uriStr);
        String name = sanitizeFileName(call.getString("name", "document.md"));
        String mime = call.getString("mimeType", "text/markdown");

        Uri shareUri;
        try {
            shareUri = copyToShareCache(source, name);
        } catch (SecurityException e) {
            call.reject("이 파일에 접근할 권한이 없습니다", "EPERM", e);
            return;
        } catch (IOException | RuntimeException e) {
            call.reject("공유할 사본을 만들지 못했습니다", "EIO", e);
            return;
        }

        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, shareUri);
        send.putExtra(Intent.EXTRA_TITLE, name);
        // 메일 앱은 제목을 여기서 읽는다.
        send.putExtra(Intent.EXTRA_SUBJECT, name);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // ★★ Android 10+ 에서는 ClipData 에 URI 가 있어야 읽기 권한이 받는 앱까지 전달된다.
        send.setClipData(ClipData.newRawUri(name, shareUri));

        Intent chooser = Intent.createChooser(send, call.getString("dialogTitle", "문서 공유"));
        startActivityForResult(call, chooser, "shareFileResult");
    }

    /**
     * 공유용 사본을 앱 캐시에 만들고 **FileProvider URI** 를 돌려준다.
     *
     * ★★ 원본 SAF URI 를 그대로 EXTRA_STREAM 에 넣으면 받는 앱이 못 읽는 경우가 있다.
     *   2026-08-04 실측: 우리 앱끼리는 잘 주고받았지만(로그로 확인) **카카오톡이 받지 않았다.**
     *   `content://com.android.providers.downloads.documents/document/msf:...` 같은
     *   SAF 문서 URI 는 '공유 출처'로는 드물어서 받는 앱이 검증하지 않았을 가능성이 크다.
     *   반면 `content://<우리앱>.fileprovider/...` 는 거의 모든 앱이 쓰는 표준 경로다.
     *
     * ★ 사본 비용은 무시할 만하다 — 렌더 상한이 4MB 이고 캐시 쓰기는 로컬이다.
     *   대신 매번 지난 사본을 지워서 캐시가 무한히 자라지 않게 한다.
     */
    private Uri copyToShareCache(Uri source, String name) throws IOException {
        java.io.File dir = new java.io.File(getContext().getCacheDir(), "share");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("캐시 폴더를 만들지 못했습니다");

        // 지난 사본 정리. 남겨 둘 이유가 없다 — 공유 시트가 닫히면 쓸모가 없다.
        java.io.File[] old = dir.listFiles();
        if (old != null) for (java.io.File f : old) f.delete();

        java.io.File out = new java.io.File(dir, name);
        try (InputStream is = getContext().getContentResolver().openInputStream(source);
             FileOutputStream fos = new FileOutputStream(out)) {
            if (is == null) throw new IOException("원본을 열 수 없습니다");
            byte[] buf = new byte[8192];
            int n;
            long total = 0;
            while ((n = is.read(buf)) != -1) {
                total += n;
                if (total > MAX_BYTES) throw new IOException("파일이 너무 큽니다");
                fos.write(buf, 0, n);
            }
        }

        return androidx.core.content.FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", out);
    }

    /** 파일 이름에 쓸 수 없는 문자를 없앤다. 경로 탈출(../)도 여기서 막힌다. */
    private static String sanitizeFileName(String name) {
        String s = name.replaceAll("[\\/:*?\"<>|]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) return "document.md";
        return s.length() > 100 ? s.substring(0, 100) : s;
    }

    @ActivityCallback
    private void shareFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        // 사용자가 취소해도 RESULT_CANCELED 다. 공유 자체의 성공 여부는 알 수 없다
        // (받는 앱이 알려주지 않는다). 여기서는 '창을 띄웠다'까지만 보장한다.
        JSObject ret = new JSObject();
        ret.put("completed", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(ret);
    }

    // ────────────────────────────────────────────────────────────
    // 시스템 정보
    // ────────────────────────────────────────────────────────────

    /**
     * OS의 글꼴 크기 설정 배율. 1.0 = 기본, 1.3 = '크게', 2.0 = 최대.
     *
     * ★★ **글자 크기 보정에 쓰지 마라.** 예전에는 첫 실행에서 이 값으로 fontStep 을
     *   올렸는데, 웹뷰가 이미 같은 배율을 먹이고 있어서 **두 번 곱해졌다**
     *   (2026-08-06 실측: 배율 2.0 에서 본문이 34px 가 아니라 48px).
     *   "본문에 text-size-adjust:none 을 걸어 OS 확대를 껐다" 는 것이 근거였는데
     *   그 속성은 시스템 글꼴 배율(WebSettings.setTextZoom)을 끄지 못한다.
     *
     * ★ 지금 이 메서드는 **플러그인이 붙어 있는지 확인하는 용도**로만 남아 있다
     *   (md-file.ts 의 isMdFileAvailable). 진단에 쓰고 싶으면 그때 다시 꺼내라.
     */
    @PluginMethod
    public void getSystemFontScale(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("scale", getContext().getResources().getConfiguration().fontScale);
        } catch (Exception e) {
            ret.put("scale", 1.0f);
        }
        call.resolve(ret);
    }

    // ────────────────────────────────────────────────────────────
    // 메타데이터
    // ────────────────────────────────────────────────────────────

    /** URI 하나에 대한 이름/크기/MIME/쓰기가능 여부를 모은다. */
    private JSObject describe(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        JSObject o = new JSObject();
        o.put("uri", uri.toString());

        String name = null;
        long size = -1;

        if ("content".equals(uri.getScheme())) {
            try (Cursor c = cr.query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                    null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
                }
            } catch (Exception e) {
                Log.w(TAG, "메타데이터 조회 실패: " + e.getMessage());
            }
        }
        if (name == null) name = uri.getLastPathSegment();

        /*
         * ★ 이름을 못 얻었을 때의 대체값. **말을 넣지 마라** — 여기는 자바라
         *   앱의 번역 카탈로그를 못 읽는다. 예전에는 "문서" 였는데,
         *   영어로 쓰는 사용자에게 그대로 한국어가 보였다(2026-08-06).
         *   파일 이름 모양이면 어느 언어에서도 어색하지 않고, 공유 캐시의
         *   기본 이름(sanitizeFileName)과도 같은 값이다.
         */
        o.put("name", name == null ? "document.md" : name);
        o.put("size", size);
        o.put("mimeType", safeType(cr, uri));
        o.put("writable", isWritable(uri));
        return o;
    }

    private static String safeType(ContentResolver cr, Uri uri) {
        try { return cr.getType(uri); } catch (Exception e) { return null; }
    }

    /**
     * 실제로 쓸 수 있는 문서인지 판단한다.
     * ★ 쓰기 모드로 열어 보는 방식은 절대 쓰면 안 된다 — 그 자체로 파일이 잘려나간다.
     *   반드시 FLAG_SUPPORTS_WRITE 플래그로만 판단한다.
     */
    private boolean isWritable(Uri uri) {
        try {
            if (!DocumentsContract.isDocumentUri(getContext(), uri)) return false;
            try (Cursor c = getContext().getContentResolver().query(uri,
                    new String[]{DocumentsContract.Document.COLUMN_FLAGS}, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) {
                    int flags = c.getInt(0);
                    return (flags & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) != 0;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "쓰기 가능 여부 확인 실패: " + e.getMessage());
        }
        return false;
    }

    private String treeDisplayName(Uri tree) {
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = getContext().getContentResolver().query(doc,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
            }
        } catch (Exception ignored) { }
        return "폴더";
    }
}
