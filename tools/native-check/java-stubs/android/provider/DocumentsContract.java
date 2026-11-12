package android.provider;
import android.content.ContentResolver;
import android.net.Uri;
import java.io.FileNotFoundException;
public final class DocumentsContract {
  public static final class Document { public static final String COLUMN_DOCUMENT_ID = "document_id", COLUMN_DISPLAY_NAME = "_display_name", COLUMN_MIME_TYPE = "mime_type", COLUMN_SIZE = "_size", COLUMN_LAST_MODIFIED = "last_modified", MIME_TYPE_DIR = "vnd.android.document/directory"; }
  public static String getTreeDocumentId(Uri documentUri) { return null; }
  public static String getDocumentId(Uri documentUri) { return null; }
  public static Uri buildDocumentUriUsingTree(Uri treeUri, String documentId) { return null; }
  public static Uri buildChildDocumentsUriUsingTree(Uri treeUri, String parentDocumentId) { return null; }
  public static Uri createDocument(ContentResolver content, Uri parentDocumentUri, String mimeType, String displayName) throws FileNotFoundException { return null; }
  public static Uri renameDocument(ContentResolver content, Uri documentUri, String displayName) throws FileNotFoundException { return null; }
  public static Uri moveDocument(ContentResolver content, Uri sourceDocumentUri, Uri sourceParentDocumentUri, Uri targetParentDocumentUri) throws FileNotFoundException { return null; }
  public static boolean deleteDocument(ContentResolver content, Uri documentUri) throws FileNotFoundException { return false; }
}
