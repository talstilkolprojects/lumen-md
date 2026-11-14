package android.content;
import android.database.Cursor;
import android.net.Uri;
import java.io.*;
import java.util.List;
public abstract class ContentResolver {
  public final void takePersistableUriPermission(Uri uri, int modeFlags) {}
  public List<UriPermission> getPersistedUriPermissions() { return null; }
  public final InputStream openInputStream(Uri uri) throws FileNotFoundException { return null; }
  public final OutputStream openOutputStream(Uri uri, String mode) throws FileNotFoundException { return null; }
  public final Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
  public final android.os.ParcelFileDescriptor openFileDescriptor(Uri uri, String mode) throws FileNotFoundException { return null; }
}
