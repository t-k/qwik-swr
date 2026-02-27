import type { RequestHandler } from "@builder.io/qwik-city";
import { getUsers } from "~/lib/mock-db";

export const onGet: RequestHandler = async ({ query, json }) => {
  const page = Number(query.get("page") ?? "1");
  json(200, getUsers(page));
};
