import { EmployeeChat } from "@/components/employee-chat";
import { AdminConsole } from "@/components/admin-console";

export default function Home() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b bg-white px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-go-600">●</span> Greenlight
          </h1>
          <p className="hidden text-sm text-neutral-500 md:block">
            An IT agent that acts instantly when policy allows — and asks a human when it doesn&apos;t.
          </p>
        </div>
        <span className="rounded-full border border-go-200 bg-go-50 px-3 py-1 text-xs font-medium text-go-700">
          Sandbox connectors · every action logged
        </span>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,30rem)_1fr]">
        <section className="flex min-h-0 flex-col border-r bg-white">
          <EmployeeChat />
        </section>
        <section className="flex min-h-0 flex-col">
          <AdminConsole />
        </section>
      </main>
    </div>
  );
}
