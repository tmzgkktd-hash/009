package com.voicetype.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 暴露给网页的落盘桥。
 *
 * 网页侧调用：window.__yzwSave.save(文件名, 文本, MIME) → 返回落盘路径，失败返回空串。
 *
 * 为什么不直接用 <a download> + blob：
 * WebView 遇到 blob: URL 的下载请求不会走 DownloadListener，点了完全没反应，
 * 而且不报任何错。所以安卓壳必须自己提供一个写文件的通道，
 * 否则「转换完的文字保存为 txt / html」这个功能在手机上等于不存在。
 *
 * 落点：
 *   Android 10（API 29）及以上 → MediaStore 的 Downloads 集合，
 *   免存储权限，文件出现在系统「下载/音转文」里，文件管理器直接可见。
 *   Android 9 及以下 → 公共「下载」目录，需要 WRITE_EXTERNAL_STORAGE。
 *
 * 注意：@JavascriptInterface 标注的方法跑在 WebView 的 JavaBridge 线程上，
 * 不是主线程，所以这里做文件 I/O 不会卡 UI。也正因为不在主线程，
 * 不能碰任何 View —— 提示交给网页侧 toast。
 */
public class SaveBridge {

    private static final String TAG = "VoiceType";
    /** 下载目录下的子文件夹，避免用户的上百个文件混在「下载」根目录里 */
    private static final String SUBDIR = "音转文";

    private final Context ctx;

    SaveBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /**
     * 把一段文本写进本地文件。
     *
     * @param filename 建议的文件名，例如 音转文-20260913-1530.txt
     * @param content  文件内容（UTF-8）
     * @param mime     MIME 类型，例如 text/plain;charset=utf-8
     * @return 落盘路径；失败返回空串
     */
    @JavascriptInterface
    public String save(String filename, String content, String mime) {
        if (filename == null || filename.isEmpty()) return "";
        // 文件名里不能有路径分隔符，否则会被当成子目录（也堵住 ../ 穿越）
        String safeName = filename.replace('/', '_').replace('\\', '_').trim();
        if (safeName.isEmpty() || safeName.startsWith(".")) return "";
        if (mime == null || mime.isEmpty()) mime = "text/plain;charset=utf-8";
        if (content == null) content = "";

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                return saveViaMediaStore(safeName, content, mime);
            }
            return saveViaLegacyDownloads(safeName, content);
        } catch (Throwable e) {
            Log.e(TAG, "保存失败：" + safeName, e);
            return "";
        }
    }

    /** Android 10+：走 MediaStore，不需要任何存储权限 */
    private String saveViaMediaStore(String name, String content, String mime) throws Exception {
        String rel = Environment.DIRECTORY_DOWNLOADS + "/" + SUBDIR;

        // 先自己挑一个不撞车的名字，别把重名的难题甩给系统。
        //
        // 系统确实会兜底 —— 重复时自动改成「xxx.txt (1)」。但那个兜底有个坑：
        // 后缀加在了**扩展名之后**，文件变成「音转文-20260915-1318.txt (1)」，
        // MediaStore 再按扩展名推 MIME 就推不出来了，实测写进去的是
        //   mime_type = application/octet-stream
        // （同一批里没撞车的那份是 text/plain，撞车的两份都是 octet-stream，
        //   对照过才敢这么归因。）
        // 后果不只是图标难看：文件管理器里点它，系统找不到能打开的应用，
        // 用户会以为「导出的文件坏了」。
        //
        // 所以自己来：把序号放在扩展名**前面**（xxx(2).txt），
        // 既保留了扩展名、MIME 始终正确，也和下面 Android 9 分支的命名规则一致。
        String unique = uniqueName(name, rel);

        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, unique);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);

        Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (uri == null) return "";

        try (OutputStream os = ctx.getContentResolver().openOutputStream(uri, "w")) {
            if (os == null) return "";
            os.write(content.getBytes(StandardCharsets.UTF_8));
            os.flush();
        } catch (Throwable e) {
            // 写不进去就把这条空记录删掉，别在「下载」里留个 0 字节的垃圾文件
            try { ctx.getContentResolver().delete(uri, null, null); } catch (Throwable ignored) {}
            throw e;
        }

        // 报路径时以 MediaStore 里查到的为准，不用我们提交的那个名字。
        // 万一上面挑名字和真正插入之间被别的写入抢了先（同一分钟连点两次导出），
        // 系统还是会改名；回查一次才能保证 toast 里报的路径是**真**存在的那个。
        // 查不到就退回提交的名字 —— 那种情况下文件本身是好的，只是报得不准。
        return Environment.DIRECTORY_DOWNLOADS + "/" + SUBDIR + "/" + actualName(uri, unique);
    }

    /** 如果 {@code name} 在下载目录里已经存在，就加 (2)(3)… 直到不撞车（序号在扩展名之前） */
    private String uniqueName(String name, String rel) {
        if (!existsInDownloads(name, rel)) return name;
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
        for (int i = 2; i < 1000; i++) {
            String cand = base + "(" + i + ")" + ext;
            if (!existsInDownloads(cand, rel)) return cand;
        }
        // 真有一千个同名就很离谱了，退回到时间戳，至少不会覆盖已有文件
        return base + "(" + System.currentTimeMillis() + ")" + ext;
    }

    /** 下载目录里是否已经有同名文件 */
    private boolean existsInDownloads(String name, String rel) {
        Cursor c = null;
        try {
            // ⚠️ 路径比较要连 **结尾斜杠** 一起容忍。
            //    传给 insert 的 RELATIVE_PATH 写的是 "Download/音转文"（无斜杠），
            //    但 MediaStore 存进去、查出来是 "Download/音转文/"（有斜杠）——
            //    它会自动规范化。第一版这里只按无斜杠的比，一次都没匹配上，
            //    于是预检形同虚设，重名仍然落到系统兜底那条路上（MIME 退化）。
            //    两种写法都放进去比，免得再依赖「它到底会不会补斜杠」这种细节。
            c = ctx.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.MediaColumns._ID},
                    MediaStore.MediaColumns.DISPLAY_NAME + "=? AND ("
                            + MediaStore.MediaColumns.RELATIVE_PATH + "=? OR "
                            + MediaStore.MediaColumns.RELATIVE_PATH + "=?)",
                    new String[]{name, rel, rel + "/"},
                    null);
            return c != null && c.moveToFirst();
        } catch (Throwable e) {
            // 查不动就当不存在。最坏情况是系统再兜一次底（名字带尾随序号），
            // 文件仍然会写成功，只是 MIME 可能退化；总好过在这里直接放弃保存。
            return false;
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) {} }
        }
    }

    /** 回查刚写入那条记录的真实显示名 */
    private String actualName(Uri uri, String fallback) {
        try (Cursor c = ctx.getContentResolver().query(
                uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String real = c.getString(idx);
                    if (real != null && !real.isEmpty()) return real;
                }
            }
        } catch (Throwable e) {
            Log.w(TAG, "回查文件名失败，沿用提交的名字", e);
        }
        return fallback;
    }

    /** Android 9 及以下：直接写公共「下载」目录 */
    private String saveViaLegacyDownloads(String name, String content) throws Exception {
        File dir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            SUBDIR);
        if (!dir.exists() && !dir.mkdirs()) return "";

        File out = new File(dir, name);
        // 同名不覆盖：追加 (2) (3) ...，避免用户前一次导出的内容被悄悄冲掉
        if (out.exists()) {
            String base = name;
            String ext = "";
            int dot = name.lastIndexOf('.');
            if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
            for (int i = 2; i < 1000; i++) {
                File cand = new File(dir, base + "(" + i + ")" + ext);
                if (!cand.exists()) { out = cand; break; }
            }
        }

        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(content.getBytes(StandardCharsets.UTF_8));
            fos.flush();
        }
        return out.getAbsolutePath();
    }
}
