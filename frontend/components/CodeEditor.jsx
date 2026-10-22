import { useRef, useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { BACKEND_URL } from "../lib/config";

// Monaco must be loaded client-side only
const Monaco = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const LANGUAGES = [
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "cpp", label: "C++" },
  { value: "typescript", label: "TypeScript" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
];

const PISTON_LANG = {
  javascript: "javascript",
  python: "python",
  java: "java",
  cpp: "c++",
  typescript: "typescript",
  go: "go",
  rust: "rust",
};

const PLACEHOLDERS = {
  javascript: '// Start coding...\n\nfunction solution() {\n  console.log("Hello, World!");\n}\n\nsolution();',
  python: '# Start coding...\n\ndef solution():\n    print("Hello, World!")\n\nsolution()',
  java: '// Start coding...\n\npublic class Solution {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
  cpp: '// Start coding...\n\n#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
  typescript: '// Start coding...\n\nfunction solution(): void {\n  console.log("Hello, World!");\n}\n\nsolution();',
  go: '// Start coding...\n\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
  rust: '// Start coding...\n\nfn main() {\n    println!("Hello, World!");\n}',
};

const MIN_OUTPUT_H = 80;
const MAX_OUTPUT_H = 500;
const DEFAULT_OUTPUT_H = 200;

function useDebounce(fn, delay) {
  const timer = useRef(null);
  return useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

function useOutputResize(initial) {
  const [height, setHeight] = useState(initial);
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    document.body.classList.add("resizing-row");
    const onMove = (ev) => {
      const delta = startY - ev.clientY;
      setHeight(Math.min(MAX_OUTPUT_H, Math.max(MIN_OUTPUT_H, startH + delta)));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-row");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height]);
  return [height, onMouseDown];
}

function sanitizeCursorShape(cursorData) {
  if (!cursorData) return null;
  const safeNum = (n, fallback = 1) => {
    const x = Number(n);
    return Number.isFinite(x) ? Math.max(1, Math.floor(x)) : fallback;
  };

  const position = cursorData.position
    ? {
        lineNumber: safeNum(cursorData.position.lineNumber),
        column: safeNum(cursorData.position.column),
      }
    : null;

  const selection = cursorData.selection
    ? {
        startLineNumber: safeNum(cursorData.selection.startLineNumber),
        startColumn: safeNum(cursorData.selection.startColumn),
        endLineNumber: safeNum(cursorData.selection.endLineNumber),
        endColumn: safeNum(cursorData.selection.endColumn),
      }
    : null;

  return { position, selection };
}

const CURSOR_COLORS = [
  "#f59e0b", // amber
  "#22c55e", // green
  "#3b82f6", // blue
  "#e879f9", // fuchsia
  "#fb7185", // rose
  "#14b8a6", // teal
  "#a3e635", // lime
  "#f97316", // orange
  "#60a5fa", // light blue
  "#c084fc", // violet
];

function hashUserId(userId = "") {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorForUser(userId) {
  return CURSOR_COLORS[hashUserId(userId) % CURSOR_COLORS.length];
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((ch) => ch + ch).join("")
    : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function classSuffixForUser(userId = "") {
  return `u${hashUserId(userId)}`;
}

export default function CodeEditor({
  code,
  onCodeChange,
  language,
  onLanguageChange = () => {},
  roomId,
  guestId,
  currentUserId,
  codeExecution = true,
  remoteCursors = {},
  onCursorActivity = () => {},
}) {
  const lang = PISTON_LANG[language] ? language : "javascript";
  const [running, setRunning] = useState(false);
  const [runningTests, setRunningTests] = useState(false);
  const [output, setOutput] = useState(null);
  const [showOutput, setShowOutput] = useState(false);
  const [showTests, setShowTests] = useState(true);
  const [outputH, onOutputDrag] = useOutputResize(DEFAULT_OUTPUT_H);
  const [runInput, setRunInput] = useState("");
  const [testCases, setTestCases] = useState([
    { id: 1, input: "", expected: "" },
    { id: 2, input: "", expected: "" },
  ]);
  const [testResults, setTestResults] = useState({});

  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const editorDisposablesRef = useRef([]);
  const dynamicStyleRef = useRef(null);
  const injectedUsersRef = useRef(new Set());
  const nextTestIdRef = useRef(3);

  const displayCode = code || PLACEHOLDERS[lang];
  const emitChange = useDebounce(onCodeChange, 300);
  const emitCursor = useDebounce((payload) => onCursorActivity(payload), 80);

  useEffect(() => {
    return () => {
      editorDisposablesRef.current.forEach((d) => d?.dispose?.());
      editorDisposablesRef.current = [];
      if (dynamicStyleRef.current?.parentNode) {
        dynamicStyleRef.current.parentNode.removeChild(dynamicStyleRef.current);
      }
    };
  }, []);

  const ensureCursorStyles = useCallback((userId) => {
    if (!userId || injectedUsersRef.current.has(userId)) return;

    if (!dynamicStyleRef.current) {
      dynamicStyleRef.current = document.createElement("style");
      dynamicStyleRef.current.setAttribute("data-blip-cursor-styles", "1");
      document.head.appendChild(dynamicStyleRef.current);
    }

    const color = colorForUser(userId);
    const suffix = classSuffixForUser(userId);
    const cursorClass = `.monaco-editor .blip-remote-cursor-${suffix}`;
    const selectionClass = `.monaco-editor .blip-remote-selection-${suffix}`;
    dynamicStyleRef.current.appendChild(document.createTextNode(`
${cursorClass} {
  border-left: 2px solid ${color};
  background: ${hexToRgba(color, 0.22)};
}
${selectionClass} {
  background: ${hexToRgba(color, 0.18)};
  border-radius: 2px;
}
`));

    injectedUsersRef.current.add(userId);
  }, []);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;

    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const next = [];

    for (const cursor of Object.values(remoteCursors || {})) {
      if (!cursor || cursor.userId === currentUserId) continue;

      const clean = sanitizeCursorShape(cursor);
      if (!clean) continue;

      ensureCursorStyles(cursor.userId);
      const suffix = classSuffixForUser(cursor.userId);

      if (clean.selection) {
        const { startLineNumber, startColumn, endLineNumber, endColumn } = clean.selection;
        const hasRange = startLineNumber !== endLineNumber || startColumn !== endColumn;
        if (hasRange) {
          next.push({
            range: new monaco.Range(startLineNumber, startColumn, endLineNumber, endColumn),
            options: {
              className: `blip-remote-selection-${suffix}`,
              hoverMessage: { value: `${cursor.displayName || "Participant"} selection` },
            },
          });
        }
      }

      if (clean.position) {
        const { lineNumber, column } = clean.position;
        next.push({
          range: new monaco.Range(lineNumber, column, lineNumber, column + 1),
          options: {
            className: `blip-remote-cursor-${suffix}`,
            hoverMessage: { value: `${cursor.displayName || "Participant"} cursor` },
          },
        });
      }
    }

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, next);
  }, [remoteCursors, currentUserId, ensureCursorStyles]);

  const publishLocalCursor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const pos = editor.getPosition();
    const sel = editor.getSelection();
    emitCursor({
      position: pos
        ? {
            lineNumber: pos.lineNumber,
            column: pos.column,
          }
        : null,
      selection: sel
        ? {
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: sel.endLineNumber,
            endColumn: sel.endColumn,
          }
        : null,
    });
  }, [emitCursor]);

  const onEditorMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editorDisposablesRef.current.forEach((d) => d?.dispose?.());
    editorDisposablesRef.current = [];

    editorDisposablesRef.current.push(editor.onDidChangeCursorPosition(publishLocalCursor));
    editorDisposablesRef.current.push(editor.onDidChangeCursorSelection(publishLocalCursor));

    publishLocalCursor();
  };

  const handleEditorChange = (value) => {
    emitChange(value || "");
  };

  const handleLangChange = (newLang) => {
    onLanguageChange(newLang);
    setOutput(null);
    setTestResults({});
    if (!code) onCodeChange(PLACEHOLDERS[newLang]);
  };

  const executeCode = async (stdin = "") => {
    const res = await fetch(`${BACKEND_URL}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId,
        guestId,
        language: PISTON_LANG[lang],
        code: displayCode,
        stdin,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    const run = data.run || {};
    return {
      stdout: run.stdout || "",
      stderr: run.stderr || "",
      exitCode: run.exitCode ?? 0,
      time: run.time || null,
    };
  };

  const runCode = async () => {
    setRunning(true);
    setShowOutput(true);
    setOutput(null);

    try {
      const run = await executeCode(runInput);
      setOutput(run);
    } catch (err) {
      setOutput({ stdout: "", stderr: err.message, exitCode: -1, time: null });
    } finally {
      setRunning(false);
    }
  };

  const runAllTests = async () => {
    setRunningTests(true);
    setTestResults({});

    try {
      for (const testCase of testCases) {
        try {
          const run = await executeCode(testCase.input || "");
          const actual = (run.stdout || "").trim();
          const expected = (testCase.expected || "").trim();
          const pass = run.exitCode === 0 && !run.stderr && (expected === "" || actual === expected);

          setTestResults((prev) => ({
            ...prev,
            [testCase.id]: {
              ...run,
              pass,
              actual,
            },
          }));
        } catch (err) {
          setTestResults((prev) => ({
            ...prev,
            [testCase.id]: {
              stdout: "",
              stderr: err.message,
              exitCode: -1,
              time: null,
              pass: false,
              actual: "",
            },
          }));
        }
      }
    } finally {
      setRunningTests(false);
    }
  };

  const addTestCase = () => {
    setTestCases((prev) => [...prev, { id: nextTestIdRef.current++, input: "", expected: "" }]);
  };

  const removeTestCase = (id) => {
    setTestCases((prev) => prev.filter((t) => t.id !== id));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const updateTestCase = (id, patch) => {
    setTestCases((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const hasError = output && (output.exitCode !== 0 || output.stderr);
  const outputText = output
    ? (output.stdout || "") + (output.stderr ? (output.stdout ? "\n--- stderr ---\n" : "") + output.stderr : "")
    : "";

  return (
    <div className="flex flex-col h-full" style={{ background: "#07070e" }}>
      <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ background: "#0a0a14", borderBottom: "1px solid rgba(255,255,255,0.055)" }}>
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "rgba(255,255,255,0.22)" }}>
          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
        </svg>
        <span className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.22)" }}>Editor</span>
        <div className="flex-1" />

        <select
          value={lang}
          onChange={(e) => handleLangChange(e.target.value)}
          className="text-xs rounded px-2 py-1 focus:outline-none"
          style={{ background: "#131320", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)" }}
        >
          {LANGUAGES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <button
          onClick={() => setShowTests((v) => !v)}
          className="text-xs px-2 py-1 rounded border transition-colors"
          style={{ borderColor: "rgba(255,255,255,0.11)", color: "rgba(255,255,255,0.58)", background: showTests ? "rgba(220,38,38,0.12)" : "transparent" }}
          title="Toggle test cases panel"
        >
          {showTests ? "Hide Tests" : "Show Tests"}
        </button>

        <button
          onClick={runCode}
          disabled={running || runningTests || !codeExecution}
          title={codeExecution ? "Run code" : "Code execution is disabled on this server"}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold transition-all ${
            running ? "cursor-wait" : "cursor-pointer"
          }`}
          style={!codeExecution
            ? { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.3)", cursor: "not-allowed" }
            : running
            ? { background: "rgba(22,163,74,0.15)", border: "1px solid rgba(22,163,74,0.3)", color: "#4ade80" }
            : { background: "rgba(22,163,74,0.18)", border: "1px solid rgba(22,163,74,0.35)", color: "#4ade80" }
          }
        >
          {running ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              Running...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Run
            </>
          )}
        </button>

        {output !== null && (
          <button
            onClick={() => setShowOutput((v) => !v)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              hasError ? "border-red-800 text-red-400 hover:bg-red-950/30" : "border-green-800 text-green-400 hover:bg-green-950/30"
            }`}
          >
            {showOutput ? "Hide Output" : "Show Output"}
            {output.exitCode !== 0 && " (error)"}
          </button>
        )}
      </div>

      {showTests && (
        <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.055)", background: "#0a0a14" }}>
          {!codeExecution && (
            <p className="text-[11px] mb-2 px-2 py-1.5 rounded" style={{ color: "#fcd34d", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
              Running code is disabled on this server. Editing and syncing still work.
            </p>
          )}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.22)" }}>Test Cases</span>
            <div className="flex-1" />
            <button
              onClick={addTestCase}
              className="text-xs px-2 py-1 rounded"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.65)" }}
            >
              + Add
            </button>
            <button
              onClick={runAllTests}
              disabled={running || runningTests || testCases.length === 0 || !codeExecution}
              title={codeExecution ? undefined : "Code execution is disabled on this server"}
              className="text-xs px-2 py-1 rounded"
              style={{ background: "rgba(220,38,38,0.16)", color: "#fca5a5", opacity: (running || runningTests || testCases.length === 0 || !codeExecution) ? 0.45 : 1 }}
            >
              {runningTests ? "Running Tests..." : "Run Tests"}
            </button>
          </div>

          <div className="mb-2">
            <label className="text-[10px] uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.24)" }}>Custom Input For Run</label>
            <textarea
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              className="w-full mt-1 px-2 py-1.5 rounded text-xs"
              rows={2}
              placeholder="stdin for Run button (optional)"
              style={{ background: "#131320", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.72)" }}
            />
          </div>

          <div className="max-h-[210px] overflow-auto space-y-2 pr-1">
            {testCases.map((tc, idx) => {
              const result = testResults[tc.id];
              return (
                <div key={tc.id} className="p-2 rounded-lg" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-semibold" style={{ color: "rgba(255,255,255,0.62)" }}>Test {idx + 1}</span>
                    <div className="flex-1" />
                    {result && (
                      <span className="text-[10px]" style={{ color: result.pass ? "#4ade80" : "#f87171" }}>
                        {result.pass ? "PASS" : "FAIL"}
                      </span>
                    )}
                    <button
                      onClick={() => removeTestCase(tc.id)}
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ color: "rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.04)" }}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <textarea
                      value={tc.input}
                      onChange={(e) => updateTestCase(tc.id, { input: e.target.value })}
                      rows={2}
                      placeholder="Input"
                      className="px-2 py-1.5 rounded text-xs"
                      style={{ background: "#131320", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.72)" }}
                    />
                    <textarea
                      value={tc.expected}
                      onChange={(e) => updateTestCase(tc.id, { expected: e.target.value })}
                      rows={2}
                      placeholder="Expected output"
                      className="px-2 py-1.5 rounded text-xs"
                      style={{ background: "#131320", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.72)" }}
                    />
                  </div>
                  {result && (
                    <p className="mt-1 text-[10px]" style={{ color: "rgba(255,255,255,0.4)" }}>
                      Actual: {result.actual || "(empty)"}
                      {result.stderr ? ` | Error: ${result.stderr}` : ""}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden monaco-wrapper min-h-0">
        <Monaco
          height="100%"
          language={lang === "cpp" ? "cpp" : lang}
          theme="vs-dark"
          value={displayCode}
          onChange={handleEditorChange}
          onMount={onEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontLigatures: true,
            wordWrap: "on",
            lineNumbers: "on",
            renderLineHighlight: "line",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            automaticLayout: true,
            padding: { top: 12 },
          }}
        />
      </div>

      {showOutput && (
        <>
          <div
            onMouseDown={onOutputDrag}
            className="flex-shrink-0 h-2 flex items-center justify-center group cursor-row-resize transition-colors"
            style={{ background: "#0a0a14", borderTop: "1px solid rgba(255,255,255,0.055)" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.12)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#0a0a14"; }}
          >
            <div className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-4 h-0.5 rounded-full transition-colors" style={{ background: "rgba(255,255,255,0.12)" }} />
              ))}
            </div>
          </div>

          <div
            className="flex-shrink-0 flex flex-col overflow-hidden"
            style={{ height: outputH, background: "#07070e", borderTop: "1px solid rgba(255,255,255,0.05)" }}
          >
            <div className="flex items-center gap-2 px-4 py-1.5 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${hasError ? "bg-red-500" : "bg-green-500"}`} />
              <span className={`text-xs font-semibold ${hasError ? "text-red-400" : "text-green-400"}`}>
                {running ? "Running..." : hasError ? `Error (exit ${output.exitCode})` : "Success"}
              </span>
              {output?.time && <span className="text-xs text-gray-600 ml-auto">{output.time}</span>}
              <button
                onClick={() => { setShowOutput(false); setOutput(null); }}
                className="ml-auto text-xs transition-colors"
                style={{ color: "rgba(255,255,255,0.2)" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.55)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.2)"; }}
              >
                Clear
              </button>
            </div>

            <pre className="flex-1 overflow-auto px-4 py-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words" style={{ color: "rgba(255,255,255,0.7)" }}>
              {running ? (
                <span className="text-gray-500 italic">Executing...</span>
              ) : outputText ? (
                outputText
              ) : (
                <span className="text-gray-600 italic">No output</span>
              )}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
