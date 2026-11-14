import { Component, ErrorInfo, ReactNode } from "react";
import { log } from "../lib/logger";
import { t } from "../i18n";

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
        <div style={{ padding: "20px", color: "hsl(var(--destructive, 0 84% 60%))", border: "1px dashed currentcolor", borderRadius: "8px", margin: "16px", fontSize: "14px", background: "hsl(var(--destructive)/0.1)" }}>
          <strong>{t("errorBoundary.heading")}</strong>
          <p style={{ marginTop: "8px", opacity: 0.8, fontSize: "12px", fontFamily: "monospace" }}>
            {this.state.error?.message ?? t("errorBoundary.unexpected")}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
