import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Minus, RotateCw, X } from "lucide-react";
import { useApp } from "../store";
import { IconButton } from "./Common";

export function BrowserPanel() {
  const state = useApp();
  const viewRef = useRef<any>(null);
  const [address, setAddress] = useState(state.browserUrl);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("Browser");

  const sync = () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const current = view.getURL();
      if (current) setAddress(current);
      setCanBack(!!view.canGoBack());
      setCanForward(!!view.canGoForward());
    } catch {
      /* not ready */
    }
  };

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      sync();
    };
    const onTitle = (event: any) => setTitle(event.title || "Browser");
    const names = ["dom-ready", "did-navigate", "did-navigate-in-page", "did-fail-load"];
    for (const name of names) view.addEventListener(name, sync);
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("page-title-updated", onTitle);
    return () => {
      for (const name of names) view.removeEventListener(name, sync);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("page-title-updated", onTitle);
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !state.browserUrl) return;
    try {
      if (view.getURL() !== state.browserUrl) void view.loadURL(state.browserUrl);
    } catch {
      /* not ready yet */
    }
  }, [state.browserUrl]);

  const go = () => {
    const view = viewRef.current;
    if (!view) return;
    let value = address.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    setAddress(value);
    void view.loadURL(value).catch(() => undefined);
  };

  if (!state.browserOpen) return null;

  return (
    <section className={state.browserMinimized ? "browser-dock minimized" : "browser-dock"}>
      <div className="browser-toolbar">
        <IconButton icon={<ArrowLeft size={14} />} label="Back" disabled={!canBack} onClick={() => { try { viewRef.current?.goBack(); } catch { /* ignore */ } }} />
        <IconButton icon={<ArrowRight size={14} />} label="Forward" disabled={!canForward} onClick={() => { try { viewRef.current?.goForward(); } catch { /* ignore */ } }} />
        <IconButton icon={<RotateCw size={14} />} label="Reload" onClick={() => { try { viewRef.current?.reload(); } catch { /* ignore */ } }} />
        {state.browserMinimized ? (
          <span className="browser-min-title">{title}</span>
        ) : (
          <input
            className="browser-address"
            value={address}
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") go(); }}
            placeholder="Enter a URL"
          />
        )}
        {loading ? <span className="browser-loading" /> : null}
        <IconButton icon={<Minus size={14} />} label={state.browserMinimized ? "Restore browser" : "Minimize browser"} onClick={state.toggleBrowserMinimized} />
        <IconButton icon={<X size={14} />} label="Close browser" onClick={state.closeBrowser} />
      </div>
      <div className="browser-view">
        {React.createElement("webview" as any, {
          ref: viewRef,
          src: state.browserUrl,
          partition: "persist:omp-browser",
          allowpopups: "true",
          style: { width: "100%", height: "100%" },
        })}
      </div>
    </section>
  );
}
