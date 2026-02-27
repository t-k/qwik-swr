import type { RequestHandler } from "@builder.io/qwik-city";
import { getPosts } from "~/lib/mock-db";

export const onGet: RequestHandler = async ({ json }) => {
  json(200, getPosts());
};
