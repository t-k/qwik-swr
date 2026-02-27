import type { RequestHandler } from "@builder.io/qwik-city";
import { getMessages } from "~/lib/mock-db";

export const onGet: RequestHandler = async ({ json }) => {
  json(200, getMessages());
};
