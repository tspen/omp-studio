import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "highlight.js/styles/github-dark.css";

function renderError(message: string): void {
  let banner = document.getElementById("runtime-error");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "runtime-error";
    banner.className = "error-banner";
    document.body.appendChild(banner);
  }
  banner.textContent = "";
  const text = document.createElement("div");
  text.className = "error-banner-text";
  const title = document.createElement("strong");
  title.textContent = "Something went wrong";
  const detail = document.createElement("span");
  detail.textContent = message.slice(0, 1200);
  text.append(title, detail);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.onclick = () => location.reload();
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.onclick = () => banner?.remove();
  banner.append(text, reload, dismiss);
}

window.addEventListener("error", (event) => {
  console.error(event.error ?? event.message);
  renderError(String(event.error?.stack ?? event.message ?? "Unknown script error"));
});
window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  renderError(String((event.reason as Error)?.stack ?? event.reason ?? "Unhandled promise rejection"));
});

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("React render error", error, info);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal-screen">
          <div>
            <h1>Perch hit a UI error</h1>
            <p>The workspace and sessions are safe in the main process.</p>
            <pre>{this.state.error.stack ?? this.state.error.message}</pre>
            <button type="button" onClick={() => location.reload()}>Reload window</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
