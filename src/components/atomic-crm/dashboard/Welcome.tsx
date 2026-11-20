import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Welcome = () => (
  <Card>
    <CardHeader className="px-4">
      <CardTitle>GoPratle Prospecting CRM</CardTitle>
    </CardHeader>
    <CardContent className="px-4">
      <p className="text-sm mb-4">
        Welcome to <strong>GoPratle Prospecting CRM</strong> — your streamlined
        tool for managing contacts, tracking outreach, and moving prospects
        through your pipeline.
      </p>
      <p className="text-sm mb-4">
        This demo runs on a mock API, so you can explore and modify the data. It
        resets on reload. The full version uses Supabase for the backend.
      </p>
      <p className="text-sm">
        Built on the{" "}
        <a
          href="https://marmelab.com/atomic-crm"
          className="underline hover:no-underline"
        >
          Atomic CRM
        </a>{" "}
        open-source template.
      </p>
    </CardContent>
  </Card>
);
