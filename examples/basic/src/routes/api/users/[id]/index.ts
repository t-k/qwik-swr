import type { RequestHandler } from "@builder.io/qwik-city";
import { getUser } from "~/lib/mock-db";

export const onGet: RequestHandler = async ({ params, json, status }) => {
  const id = Number(params.id);
  const user = getUser(id);
  if (!user) {
    status(404);
    json(404, { error: "User not found" });
    return;
  }
  json(200, user);
};
