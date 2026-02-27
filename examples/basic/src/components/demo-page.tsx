import { component$, Slot } from "@builder.io/qwik";

export interface DemoPageProps {
  title: string;
  description: string;
}

export const DemoPage = component$<DemoPageProps>(({ title, description }) => {
  return (
    <div>
      <h1>{title}</h1>
      <p style={{ color: "#555", fontSize: "15px", lineHeight: "1.6" }}>{description}</p>

      <Slot name="code" />

      <hr style={{ border: "none", borderTop: "1px solid #e0e0e0", margin: "24px 0" }} />

      <Slot />
    </div>
  );
});
