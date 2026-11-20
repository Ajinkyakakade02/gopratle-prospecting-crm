import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Calendar,
  CalendarCheck,
  CalendarX,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  useGoogleCalendarStatus,
  useConnectGoogleCalendar,
  useDisconnectGoogleCalendar,
  useCalendarCallbackFeedback,
} from "./useGoogleCalendar";

export const GoogleCalendarCard = () => {
  useCalendarCallbackFeedback();
  const { data: status, isLoading, refetch } = useGoogleCalendarStatus();
  const connectMutation = useConnectGoogleCalendar();
  const disconnectMutation = useDisconnectGoogleCalendar();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const isConnected = !!status?.connected;

  const handleConnect = () => {
    connectMutation.mutate();
  };

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        setConfirmDisconnect(false);
      },
    });
  };

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 shrink-0">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">Google Calendar</h2>
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : isConnected ? (
                  <Badge
                    variant="outline"
                    className="border-green-600/50 bg-green-500/10 text-green-700 dark:text-green-400 gap-1 text-xs"
                  >
                    <CalendarCheck className="w-3 h-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <CalendarX className="w-3 h-3 text-muted-foreground" />
                    Not connected
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Sync prospect follow-ups and meetings directly to your Google Calendar.
                Events include prospect details, company context, and scheduled reminders.
              </p>

              {isConnected && status?.calendar_email && (
                <p className="text-xs text-muted-foreground mt-2 font-mono">
                  Primary Calendar: <span className="font-semibold">{status.calendar_email}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-center">
            {isLoading ? (
              <Button variant="outline" size="sm" disabled>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Checking...
              </Button>
            ) : isConnected ? (
              confirmDisconnect ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnectMutation.isPending}
                  >
                    {disconnectMutation.isPending && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    )}
                    Confirm Disconnect
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDisconnect(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetch()}
                    title="Refresh status"
                    className="p-2"
                  >
                    <RefreshCw className="w-4 h-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDisconnect(true)}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    Disconnect
                  </Button>
                </div>
              )
            ) : (
              <Button
                variant="default"
                size="sm"
                onClick={handleConnect}
                disabled={connectMutation.isPending}
                className="gap-2"
              >
                {connectMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Calendar className="w-4 h-4" />
                    Connect Google Calendar
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export const GoogleCalendarTaskControl = ({
  syncToCalendar,
  setSyncToCalendar,
}: {
  syncToCalendar: boolean;
  setSyncToCalendar: (checked: boolean) => void;
}) => {
  const { data: status, isLoading } = useGoogleCalendarStatus();
  const connectMutation = useConnectGoogleCalendar();
  const isConnected = !!status?.connected;

  if (isLoading) return null;

  return (
    <div className="rounded-lg border p-3 bg-muted/20 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="sync-google-calendar"
            checked={syncToCalendar && isConnected}
            disabled={!isConnected}
            onCheckedChange={(checked) => setSyncToCalendar(!!checked)}
          />
          <Label
            htmlFor="sync-google-calendar"
            className={`text-sm font-medium flex items-center gap-1.5 ${
              !isConnected ? "cursor-not-allowed opacity-70" : "cursor-pointer"
            }`}
          >
            <Calendar className="w-4 h-4 text-blue-500" />
            Add to Google Calendar
          </Label>
        </div>

        {isConnected ? (
          <Badge
            variant="outline"
            className="text-[11px] border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400 py-0"
          >
            Connected
          </Badge>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={connectMutation.isPending}
            className="text-xs text-primary p-0 h-auto flex items-center gap-1 underline hover:no-underline"
          >
            Connect Calendar
            <ExternalLink className="w-3 h-3" />
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground pl-6">
        {isConnected
          ? "Schedules a 30-min Google Calendar event with prospect context and reminder."
          : "Connect Google Calendar to automatically add this follow-up as a Calendar event."}
      </p>
    </div>
  );
};
