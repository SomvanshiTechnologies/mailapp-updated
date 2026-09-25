import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return false;
        return count < 1;
      },
    },
  },
});
