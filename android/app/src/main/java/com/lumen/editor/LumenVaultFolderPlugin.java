package com.lumen.editor;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Lumen's vault in a folder the user picks (plan 4.20, Android): the Storage
 * Access Framework. The JavaScript side is src/storage/vault/mobile.ts
 * (`LumenVaultFolderPlugin`, `safFs`); it checks every vault rule (no "..",
 * no overwrite without asking, parents are folders) before calling here, so
 * this stays a thin map from vault paths to document ids.
 *
 * Paths are relative to the picked tree, "/"-separated; "" is the tree.
 * Only framework APIs (DocumentsContract), no extra Gradle dependency.
 */
@CapacitorPlugin(name = "LumenVaultFolder")
public class LumenVaultFolderPlugin extends Plugin {

    // ── Picking the folder ────────────────────────────────────────────────

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            ret.put("uri", null);
            ret.put("name", "");
            call.resolve(ret);
            return;
        }
        Uri tree = data.getData();
        // Keep the permission across restarts.
        getContext().getContentResolver().takePersistableUriPermission(tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        ret.put("uri", tree.toString());
        ret.put("name", nameOf(tree, DocumentsContract.getTreeDocumentId(tree)));
        call.resolve(ret);
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        String uri = call.getString("uri", "");
        boolean granted = false;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().toString().equals(uri) && p.isReadPermission() && p.isWritePermission()) granted = true;
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    // ── Files ─────────────────────────────────────────────────────────────

    @PluginMethod
    public void readdir(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = find(tree, call.getString("path", ""));
            if (id == null) throw new FileNotFoundException("does not exist");
            JSArray files = new JSArray();
            try (Cursor c = children(tree, id)) {
                while (c != null && c.moveToNext()) files.put(entry(c));
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = find(tree, call.getString("path", ""));
            JSObject ret = new JSObject();
            ret.put("exists", id != null);
            if (id != null) {
                try (Cursor c = query(DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
                    if (c != null && c.moveToFirst()) {
                        JSObject e = entry(c);
                        ret.put("type", e.getString("type"));
                        ret.put("size", e.getLong("size"));
                        ret.put("mtime", e.getLong("mtime"));
                    }
                }
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = find(tree, call.getString("path", ""));
            if (id == null) throw new FileNotFoundException("does not exist");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = resolver().openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
                byte[] buf = new byte[65536];
                int n;
                while (in != null && (n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        try {
            Uri tree = tree(call);
            String path = call.getString("path", "");
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            String id = find(tree, path);
            if (id == null) {
                String parent = mkdirs(tree, parentOf(path));
                Uri created = DocumentsContract.createDocument(resolver(),
                        DocumentsContract.buildDocumentUriUsingTree(tree, parent), "application/octet-stream", baseOf(path));
                if (created == null) throw new FileNotFoundException("could not create " + path);
                id = DocumentsContract.getDocumentId(created);
            }
            // "wt": truncate, so a shorter note leaves no tail of the old one.
            // The app writes a temporary file and renames it (plan W1.5), so
            // the bytes must be on the disk before that rename: sync them.
            try (ParcelFileDescriptor pfd = resolver().openFileDescriptor(DocumentsContract.buildDocumentUriUsingTree(tree, id), "wt")) {
                if (pfd == null) throw new FileNotFoundException("could not write " + path);
                try (FileOutputStream out = new FileOutputStream(pfd.getFileDescriptor())) {
                    out.write(bytes);
                    out.flush();
                    out.getFD().sync();
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        try {
            mkdirs(tree(call), call.getString("path", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Rename in place, or move to another folder (API 24+) and rename. The target does not exist (checked in JS). */
    @PluginMethod
    public void rename(PluginCall call) {
        try {
            Uri tree = tree(call);
            String from = call.getString("from", "");
            String to = call.getString("to", "");
            String id = find(tree, from);
            if (id == null) throw new FileNotFoundException("does not exist");
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            if (!parentOf(from).equals(parentOf(to))) {
                String fromParent = find(tree, parentOf(from));
                String toParent = mkdirs(tree, parentOf(to));
                doc = DocumentsContract.moveDocument(resolver(), doc,
                        DocumentsContract.buildDocumentUriUsingTree(tree, fromParent),
                        DocumentsContract.buildDocumentUriUsingTree(tree, toParent));
                if (doc == null) throw new FileNotFoundException("could not move " + from);
            }
            if (!baseOf(from).equals(baseOf(to))) {
                if (DocumentsContract.renameDocument(resolver(), doc, baseOf(to)) == null) throw new FileNotFoundException("could not rename " + from);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = find(tree, call.getString("path", ""));
            if (id == null) throw new FileNotFoundException("does not exist");
            // Folders go with everything inside them.
            DocumentsContract.deleteDocument(resolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    private Uri tree(PluginCall call) throws FileNotFoundException {
        String uri = call.getString("uri", "");
        if (uri == null || uri.isEmpty()) throw new FileNotFoundException("no folder");
        return Uri.parse(uri);
    }

    private static String parentOf(String path) {
        int i = path.lastIndexOf('/');
        return i < 0 ? "" : path.substring(0, i);
    }

    private static String baseOf(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private Cursor query(Uri uri) {
        return resolver().query(uri, new String[] {
                Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
                Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED }, null, null, null);
    }

    private Cursor children(Uri tree, String parentId) {
        return query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId));
    }

    private static JSObject entry(Cursor c) {
        JSObject e = new JSObject();
        boolean dir = Document.MIME_TYPE_DIR.equals(c.getString(2));
        e.put("name", c.getString(1));
        e.put("type", dir ? "directory" : "file");
        e.put("size", dir || c.isNull(3) ? 0 : c.getLong(3));
        e.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
        return e;
    }

    private String nameOf(Uri tree, String id) {
        try (Cursor c = query(DocumentsContract.buildDocumentUriUsingTree(tree, id))) {
            return c != null && c.moveToFirst() ? c.getString(1) : "";
        }
    }

    /** The document id at `path` under the tree, or null. Names are compared as given. */
    private String find(Uri tree, String path) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty()) return id;
        for (String part : path.split("/")) {
            if (part.isEmpty()) continue;
            String next = null;
            try (Cursor c = children(tree, id)) {
                while (c != null && c.moveToNext()) {
                    if (part.equals(c.getString(1))) {
                        next = c.getString(0);
                        break;
                    }
                }
            }
            if (next == null) return null;
            id = next;
        }
        return id;
    }

    /** The folder at `path`, created with its parents when missing; its document id. */
    private String mkdirs(Uri tree, String path) throws FileNotFoundException {
        String id = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty()) return id;
        String sofar = "";
        for (String part : path.split("/")) {
            if (part.isEmpty()) continue;
            sofar = sofar.isEmpty() ? part : sofar + "/" + part;
            String next = find(tree, sofar);
            if (next == null) {
                Uri created = DocumentsContract.createDocument(resolver(),
                        DocumentsContract.buildDocumentUriUsingTree(tree, id), Document.MIME_TYPE_DIR, part);
                if (created == null) throw new FileNotFoundException("could not create " + sofar);
                next = DocumentsContract.getDocumentId(created);
            }
            id = next;
        }
        return id;
    }
}
