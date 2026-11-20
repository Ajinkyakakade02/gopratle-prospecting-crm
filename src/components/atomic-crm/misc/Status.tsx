import { cn } from "@/lib/utils";

import { useConfigurationContext } from "../root/ConfigurationContext";

export const Status = ({
  status,
  className,
}: {
  status: string;
  className?: string;
}) => {
  const { noteStatuses } = useConfigurationContext();
  if (!status || !noteStatuses) return null;
  const statusObject = noteStatuses.find((s: any) => s.value === status);

  if (!statusObject) return null;
  return (
    <div className={cn("group relative inline-block mr-2", className)}>
      <span
        className="inline-block w-2.5 h-2.5 rounded-full"
        style={{ backgroundColor: statusObject.color }}
      />
      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-800 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
        {statusObject.label}
      </div>
    </div>
  );
};

export const StageBadge = ({
  status,
  className,
}: {
  status?: string;
  className?: string;
}) => {
  const { noteStatuses } = useConfigurationContext();
  if (!status || !noteStatuses) return null;
  const statusObject = noteStatuses.find((s: any) => s.value === status);
  if (!statusObject) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border shadow-xs transition-colors shrink-0",
        className,
      )}
      style={{
        backgroundColor: `${statusObject.color}20`,
        borderColor: `${statusObject.color}60`,
      }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: statusObject.color }}
      />
      <span>{statusObject.label}</span>
    </span>
  );
};
