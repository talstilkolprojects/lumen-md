/** The PDF reader as the app mounts it (plan W6.25: moved out of PdfReader.tsx unchanged). */
import { t } from "../i18n";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { PdfReader } from "./PdfReader";
import type { Props } from "./pdfReaderParts";


/**
 * What the app mounts: the reader in an error boundary; "Open the notes"
 * closes it and opens the companion note through the app's open-file hub.
 */
export function PdfReaderOverlay(props: Omit<Props, "onOpenNotes">) {
  const { onClose } = props;
  return (
    <ErrorBoundary
      fallback={
        <div className="pdf-reader pdf-message pdf-error" role="alert">
          <p>{t("errorBoundary.heading")}</p>
          <button type="button" className="icon-btn pdf-text-btn" onClick={onClose}>
            {t("privacy.close")}
          </button>
        </div>
      }
    >
      <PdfReader
        {...props}
        onOpenNotes={(notePath) => {
          onClose();
          window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: notePath } }));
        }}
      />
    </ErrorBoundary>
  );
}
