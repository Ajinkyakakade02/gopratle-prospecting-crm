import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNotify } from "ra-core";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { getSupabaseClient } from "../providers/supabase/supabase";

export interface GoogleCalendarStatus {
  connected: boolean;
  calendar_email?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export function useGoogleCalendarStatus() {
  const supabase = getSupabaseClient();

  const query = useQuery<GoogleCalendarStatus>({
    queryKey: ["google-calendar", "status"],
    queryFn: async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session?.user) {
          return { connected: false };
        }

        // 1. Direct RLS select from table
        const { data: conn, error: dbError } = await supabase
          .from("google_calendar_connections")
          .select("id, calendar_email, created_at, updated_at")
          .eq("user_id", sessionData.session.user.id)
          .maybeSingle();

        if (!dbError && conn) {
          return {
            connected: true,
            calendar_email: conn.calendar_email,
            created_at: conn.created_at,
            updated_at: conn.updated_at,
          };
        }

        // 2. Fallback to edge function status check
        const { data: fnData } = await supabase.functions.invoke(
          "google-calendar-connect?action=status",
          { method: "GET" },
        );

        if (fnData?.connected) {
          return {
            connected: true,
            calendar_email: fnData.calendar_email,
            created_at: fnData.created_at,
            updated_at: fnData.updated_at,
          };
        }

        return { connected: false };
      } catch {
        return { connected: false };
      }
    },
    staleTime: 60 * 1000,
  });

  return query;
}

export function useConnectGoogleCalendar() {
  const supabase = getSupabaseClient();
  const notify = useNotify();

  const mutation = useMutation({
    mutationFn: async (returnUrl?: string) => {
      const destination =
        returnUrl ||
        (typeof window !== "undefined"
          ? `${window.location.origin}${window.location.pathname}`
          : undefined);

      const { data, error } = await supabase.functions.invoke(
        "google-calendar-connect",
        {
          body: { return_url: destination },
        },
      );

      if (error || !data?.url) {
        throw new Error(error?.message || "Failed to initiate Google Calendar connection");
      }

      return data.url as string;
    },
    onSuccess: (url) => {
      if (typeof window !== "undefined") {
        window.location.href = url;
      }
    },
    onError: (err: any) => {
      notify(err?.message || "Failed to connect Google Calendar", {
        type: "error",
      });
    },
  });

  return mutation;
}

export function useDisconnectGoogleCalendar() {
  const supabase = getSupabaseClient();
  const queryClient = useQueryClient();
  const notify = useNotify();

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        "google-calendar-disconnect",
        {
          method: "POST",
        },
      );

      if (error) {
        throw new Error(error.message || "Failed to disconnect Google Calendar");
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["google-calendar", "status"] });
      notify("Google Calendar disconnected successfully", {
        type: "info",
      });
    },
    onError: (err: any) => {
      notify(err?.message || "Error disconnecting Google Calendar", {
        type: "error",
      });
    },
  });

  return mutation;
}

export function useCreateCalendarEvent() {
  const supabase = getSupabaseClient();
  const queryClient = useQueryClient();
  const notify = useNotify();

  const mutation = useMutation({
    mutationFn: async ({
      taskId,
      durationMinutes = 30,
      timezone = "Asia/Kolkata",
    }: {
      taskId: number | string;
      durationMinutes?: number;
      timezone?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke(
        "google-calendar-create-event",
        {
          body: {
            taskId: Number(taskId),
            durationMinutes,
            timezone,
          },
        },
      );

      if (error || !data?.success) {
        throw new Error(data?.message || error?.message || "Failed to create Google Calendar event");
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      notify("Follow-up synced to Google Calendar", {
        type: "info",
      });
    },
    onError: (err: any) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      notify(err?.message || "Failed to sync event with Google Calendar", {
        type: "warning",
      });
    },
  });

  return mutation;
}

/**
 * Hook to handle OAuth callback query params (?calendar_connected=true / ?calendar_error=...)
 */
export function useCalendarCallbackFeedback() {
  const [searchParams, setSearchParams] = useSearchParams();
  const notify = useNotify();
  const queryClient = useQueryClient();

  const handleParams = useCallback(() => {
    const connected = searchParams.get("calendar_connected");
    const error = searchParams.get("calendar_error");

    if (connected === "true") {
      notify("Google Calendar connected successfully!", {
        type: "info",
      });
      queryClient.invalidateQueries({ queryKey: ["google-calendar", "status"] });
      searchParams.delete("calendar_connected");
      setSearchParams(searchParams, { replace: true });
    } else if (error) {
      notify(`Google Calendar connection error: ${error.replace(/_/g, " ")}`, {
        type: "error",
      });
      searchParams.delete("calendar_error");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, notify, queryClient]);

  useEffect(() => {
    handleParams();
  }, [handleParams]);
}
