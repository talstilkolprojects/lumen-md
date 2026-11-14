import { Component, ErrorInfo, ReactNode } from "react";
import { log } from "../lib/logger";
import { t } from "../i18n";
import { ErrorActions } from "./ErrorActions";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    log.error("uncaught error in component tree", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        // --destructive is not a token here (its fallback red was 3.8:1 on white); the
        // text is the page's own colour and the red is the frame (WCAG 1.4.3, W6.30).
        <div style={{ padding: "20px", color: "hsl(var(--fg))", border: "1px dashed hsl(var(--danger))", borderInlineStart: "4px solid hsl(var(--danger))", borderRadius: "8px", margin: "16px", fontSize: "14px", background: "hsl(var(--danger) / 0.06)" }}>
          <strong>{t("errorBoundary.heading")}</strong>
          <p style={{ marginTop: "8px", fontSize: "12px", fontFamily: "monospace" }}>
            {this.state.error?.message ?? t("errorBoundary.unexpected")}
          </p>
          <ErrorActions compact />
        </div>
      );
    }

    return this.props.children;
  }
}
