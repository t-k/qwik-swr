import { component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import type { Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

function getOrCreateHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-dark"],
        langs: ["tsx"],
      }),
    );
  }
  return highlighterPromise;
}

export interface CodeBlockProps {
  code: string;
  lang?: string;
}

export const CodeBlock = component$<CodeBlockProps>((props) => {
  const containerRef = useSignal<HTMLElement>();

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    const hl = await getOrCreateHighlighter();
    const html = hl.codeToHtml(props.code, {
      lang: props.lang ?? "tsx",
      theme: "github-dark",
    });
    if (containerRef.value) {
      containerRef.value.innerHTML = html;
      const pre = containerRef.value.querySelector("pre");
      if (pre) {
        pre.style.padding = "16px";
        pre.style.borderRadius = "6px";
        pre.style.overflowX = "auto";
        pre.style.fontSize = "13px";
        pre.style.lineHeight = "1.5";
      }
    }
  });

  return (
    <div ref={containerRef} class="code-block" style={{ margin: "16px 0" }}>
      <pre
        style={{
          background: "#24292e",
          color: "#e1e4e8",
          padding: "16px",
          borderRadius: "6px",
          overflowX: "auto",
          fontSize: "13px",
          lineHeight: "1.5",
        }}
      >
        <code>{props.code}</code>
      </pre>
    </div>
  );
});
