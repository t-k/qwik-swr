import type { RequestHandler } from "@builder.io/qwik-city";
import { getTodos, addTodo } from "~/lib/mock-db";

export const onGet: RequestHandler = async ({ json }) => {
  // Simulate slight network delay
  await new Promise((r) => setTimeout(r, 200));
  json(200, getTodos());
};

export const onPost: RequestHandler = async ({ json, parseBody }) => {
  await new Promise((r) => setTimeout(r, 300));
  const body = (await parseBody()) as { title?: string } | null;
  if (!body?.title) {
    json(400, { error: "title is required" });
    return;
  }
  const todo = addTodo(body.title);
  json(201, todo);
};
