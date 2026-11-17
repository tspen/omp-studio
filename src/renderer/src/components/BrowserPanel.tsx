import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, GitCompare, Maximize2, Minus, MousePointer2, RotateCw, TerminalSquare, Trash2, X } from "lucide-react";
import { useApp } from "../store";
import { IconButton, cx, truncate } from "./Common";

export function BrowserPanel() {
  const state = useApp();
  const viewRef = useRef<any>(null);
  const [address, setAddress] = useState(state.browserUrl);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("Browser");
  const [devtools, setDevtools] = useState(false);
  const [tab, setTab] = useState<"console" | "network">("console");
  const [picking, setPicking] = useState(false);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [device, setDevice] = useState("desktop");
  const devices = [
    { id: "desktop", label: "Desktop" },
    { id: "iphone", label: "iPhone 15", width: 393, height: 852 },
    { id: "pixel", label: "Pixel 8", width: 412, height: 915 },
    { id: "ipad", label: "iPad", width: 820, height: 1180 },
  ];
  const preset = devices.find((item) => item.id === device);

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

  useEffect(() => {
    void state.loadBrowserDevtools();
  }, []);

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await window.omp.pickBrowserElement();
      if (!picked) {
        state.pushToast({ kind: "info", title: "Element pick cancelled" });
        return;
      }
      const text = picked.text ? ` "${picked.text.slice(0, 120)}"` : "";
      state.insertComposer(`Element: ${picked.tag}${text}\nSelector: ${picked.selector}\nURL: ${address}\n\n`);
      state.pushToast({ kind: "success", title: "Element added to chat", body: picked.selector });
    } catch (error) {
      state.pushToast({ kind: "error", title: "Could not pick element", body: String(error) });
    } finally {
      setPicking(false);
    }
  };

  const visualDiff = async () => {
    try {
      const shot = await window.omp.captureBrowser();
      if (!baseline) {
        setBaseline(shot);
        state.pushToast({ kind: "info", title: "Baseline captured", body: "Change the page, then use visual diff again." });
        return;
      }
      const result = await window.omp.compareBrowserScreenshots(baseline, shot);
      setBaseline(shot);
      state.openPreview({ title: "Visual diff", kind: "image", content: "", path: result.path });
      state.pushToast({ kind: "info", title: "Visual diff", body: `${result.percent}% changed · ${result.diffPixels} pixels` });
    } catch (error) {
      state.pushToast({ kind: "error", title: "Visual diff failed", body: String(error) });
    }
  };

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
        <IconButton icon={<MousePointer2 size={14} />} label={picking ? "Click an element in the page" : "Pick element"} disabled={picking || state.browserMinimized} onClick={() => void pick()} />
        <IconButton icon={<TerminalSquare size={14} />} label="Console and network" disabled={state.browserMinimized} onClick={() => { setDevtools((value) => !value); void state.loadBrowserDevtools(); }} />
        <IconButton icon={<GitCompare size={14} />} label={baseline ? "Compare with baseline screenshot" : "Capture baseline screenshot"} disabled={state.browserMinimized} onClick={() => void visualDiff()} />
        <IconButton icon={<Maximize2 size={14} />} label="Pop out browser" disabled={state.browserMinimized} onClick={() => void window.omp.popOutBrowser(address)} />
        {!state.browserMinimized ? (
          <select className="browser-device" value={device} onChange={(event) => setDevice(event.target.value)} title="Preview viewport">
            {devices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        ) : null}
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
      <div className={cx("browser-view", !!preset?.width && "device-preview")}>
        <div className="browser-device-frame" style={preset?.width ? { width: `${preset.width}px`, height: `${preset.height}px` } : { width: "100%", height: "100%" }}>
          {React.createElement("webview" as any, {
            ref: viewRef,
            src: state.browserUrl,
            partition: "persist:omp-browser",
            allowpopups: "true",
            style: { width: "100%", height: "100%" },
          })}
        </div>
      </div>
      {devtools && !state.browserMinimized ? (
        <div className="browser-devtools">
          <div className="browser-devtools-head">
            <button type="button" className={cx("browser-devtab", tab === "console" && "active")} onClick={() => setTab("console")}>
              Console <span>{state.browserConsole.length}</span>
            </button>
            <button type="button" className={cx("browser-devtab", tab === "network" && "active")} onClick={() => setTab("network")}>
              Network <span>{state.browserNetwork.length}</span>
            </button>
            <span className="browser-devspace" />
            <IconButton icon={<Trash2 size={12} />} label="Clear" onClick={() => (tab === "console" ? state.clearBrowserConsole() : state.clearBrowserNetwork())} />
            <IconButton icon={<X size={12} />} label="Hide console" onClick={() => setDevtools(false)} />
          </div>
          <div className="browser-devtools-body">
            {tab === "console" ? (
              state.browserConsole.length ? (
                [...state.browserConsole].slice(-200).reverse().map((entry) => (
                  <div key={entry.id} className={cx("browser-devrow", `log-${entry.level}`)}>
                    <span className="browser-devlevel">{entry.level}</span>
                    <span className="browser-devmsg" title={entry.message}>{truncate(entry.message, 240)}</span>
                    {entry.source ? <span className="browser-devsrc">{entry.source.split("/").pop()}{entry.line ? `:${entry.line}` : ""}</span> : null}
                  </div>
                ))
              ) : (
                <p className="browser-devempty">No console messages yet.</p>
              )
            ) : state.browserNetwork.length ? (
              [...state.browserNetwork].slice(-200).reverse().map((entry) => (
                <div key={entry.id} className={cx("browser-devrow", entry.ok === false ? "net-bad" : "net-ok")}>
                  <span className="browser-devstatus">{entry.failed ? "ERR" : entry.status ?? "?"}</span>
                  <span className="browser-devmethod">{entry.method}</span>
                  <span className="browser-devtype">{entry.type}</span>
                  <span className="browser-devmsg" title={entry.url}>{truncate(entry.url, 200)}</span>
                  {entry.durationMs !== undefined ? <span className="browser-devsrc">{entry.durationMs} ms</span> : null}
                </div>
              ))
            ) : (
              <p className="browser-devempty">No network requests captured yet.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
