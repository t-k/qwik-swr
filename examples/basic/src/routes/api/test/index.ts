import type { RequestHandler } from "@builder.io/qwik-city";
import { incrementErrorCallCount, resetErrorCallCount } from "~/lib/mock-db";

// Server-side fetch counter (reset on server restart)
let fetchCount = 0;

export const onGet: RequestHandler = async ({ query, json, status }) => {
  const type = query.get("type") ?? "time";

  switch (type) {
    case "slow": {
      await new Promise((r) => setTimeout(r, 2000));
      json(200, { message: "Slow response", timestamp: Date.now() });
      return;
    }

    case "time": {
      fetchCount++;
      json(200, { timestamp: Date.now(), fetchCount });
      return;
    }

    case "error": {
      // ?reset=1 to reset error counter
      if (query.get("reset") === "1") {
        resetErrorCallCount();
        json(200, { message: "Counter reset" });
        return;
      }

      // ?succeedAfter=N means succeed after N failures
      const succeedAfter = Number(query.get("succeedAfter") ?? "0");
      const count = incrementErrorCallCount();

      if (succeedAfter > 0 && count > succeedAfter) {
        resetErrorCallCount();
        json(200, { message: "Success after retries", attempts: count });
        return;
      }

      status(500);
      json(500, { error: "Internal Server Error", attempt: count });
      return;
    }

    default: {
      status(400);
      json(400, { error: `Unknown type: ${type}` });
    }
  }
};
