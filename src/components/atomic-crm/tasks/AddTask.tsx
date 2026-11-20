import { Plus } from "lucide-react";
import {
  CreateBase,
  Form,
  useDataProvider,
  useGetIdentity,
  useGetRecordRepresentation,
  useNotify,
  useRecordContext,
  useTranslate,
  useUpdate,
} from "ra-core";
import { useState } from "react";
import { SaveButton } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { TaskFormContent } from "./TaskFormContent";
import { useCreateCalendarEvent } from "../google-calendar/useGoogleCalendar";

export const AddTask = ({
  selectContact,
  display = "chip",
}: {
  selectContact?: boolean;
  display?: "chip" | "icon";
}) => {
  const { identity } = useGetIdentity();
  const dataProvider = useDataProvider();
  const [update] = useUpdate();
  const notify = useNotify();
  const translate = useTranslate();
  const contact = useRecordContext();
  const [open, setOpen] = useState(false);
  const [syncToCalendar, setSyncToCalendar] = useState(true);
  const createCalendarEvent = useCreateCalendarEvent();

  // Set once per opening: a new due_date on each render would make ra-core
  // reset the form, wiping what the user already typed.
  const [dueDate, setDueDate] = useState<string>();
  const handleOpen = () => {
    setDueDate(new Date().toISOString());
    setOpen(true);
  };
  const getContactRepresentation = useGetRecordRepresentation("contacts");

  const handleSuccess = async (data: any) => {
    setOpen(false);
    const contactRecord = await dataProvider.getOne("contacts", {
      id: data.contact_id,
    });
    if (contactRecord.data) {
      await update("contacts", {
        id: contactRecord.data.id,
        data: { last_seen: new Date().toISOString() },
        previousData: contactRecord.data,
      });
    }

    notify("resources.tasks.added");

    // Automatically sync to Google Calendar if option enabled
    if (syncToCalendar && data?.id) {
      try {
        await createCalendarEvent.mutateAsync({ taskId: data.id });
      } catch {
        // Notification is already dispatched by useCreateCalendarEvent
      }
    }
  };

  if (!identity) return null;

  return (
    <>
      {display === "icon" ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="p-2 cursor-pointer"
                  onClick={handleOpen}
                  aria-label={translate("resources.tasks.action.create")}
                />
              }
            >
              <Plus className="w-4 h-4" />
            </TooltipTrigger>
            <TooltipContent>
              {translate("resources.tasks.action.create")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="my-2">
          <Button
            variant="outline"
            className="h-6 cursor-pointer"
            onClick={handleOpen}
            size="sm"
          >
            <Plus className="w-4 h-4" />
            {translate("resources.tasks.action.add")}
          </Button>
        </div>
      )}

      <CreateBase
        resource="tasks"
        record={{
          type: "none",
          contact_id: contact?.id,
          due_date: dueDate,
          sales_id: identity.id,
        }}
        mutationOptions={{ onSuccess: handleSuccess }}
      >
        <Dialog open={open} onOpenChange={() => setOpen(false)}>
          <DialogContent className="lg:max-w-xl overflow-y-auto max-h-9/10 top-1/20 translate-y-0">
            <Form className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>
                  {!selectContact
                    ? translate("resources.tasks.dialog.create_for", {
                        name: getContactRepresentation(contact!),
                      })
                    : translate("resources.tasks.dialog.create")}
                </DialogTitle>
              </DialogHeader>
              <TaskFormContent
                selectContact={selectContact}
                syncToCalendar={syncToCalendar}
                setSyncToCalendar={setSyncToCalendar}
              />
              <DialogFooter className="w-full justify-end">
                <SaveButton />
              </DialogFooter>
            </Form>
          </DialogContent>
        </Dialog>
      </CreateBase>
    </>
  );
};
