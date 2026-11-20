import { ReferenceField } from "@/components/admin";
import type { Identifier } from "ra-core";
import { useGetRecordRepresentation, useTranslate } from "ra-core";
import { EditSheet } from "../misc/EditSheet";
import { TaskFormContent } from "./TaskFormContent";
import { useState } from "react";
import { useCreateCalendarEvent } from "../google-calendar/useGoogleCalendar";

export interface TaskEditSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: Identifier;
}

export const TaskEditSheet = ({
  open,
  onOpenChange,
  taskId,
}: TaskEditSheetProps) => {
  const translate = useTranslate();
  const getContactRepresentation = useGetRecordRepresentation("contacts");
  const [syncToCalendar, setSyncToCalendar] = useState(true);
  const createCalendarEvent = useCreateCalendarEvent();

  return (
    <EditSheet
      resource="tasks"
      id={taskId}
      title={
        <ReferenceField
          source="contact_id"
          reference="contacts"
          render={({ referenceRecord }) => (
            <span className="text-xl font-semibold truncate">
              {referenceRecord
                ? translate("resources.tasks.sheet.edit_for", {
                    name: getContactRepresentation(referenceRecord),
                  })
                : translate("resources.tasks.sheet.edit")}
            </span>
          )}
        />
      }
      redirect={false}
      mutationOptions={{
        onSuccess: () => {
          if (syncToCalendar) {
            createCalendarEvent.mutate({ taskId });
          }
        },
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <TaskFormContent
        syncToCalendar={syncToCalendar}
        setSyncToCalendar={setSyncToCalendar}
      />
    </EditSheet>
  );
};
