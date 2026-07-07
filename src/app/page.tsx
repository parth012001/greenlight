import { EmployeeChat } from "@/components/employee-chat";
import { AdminConsole } from "@/components/admin-console";

export default function Home() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="gl-gantry flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="gl-signal" aria-hidden>
            <i className="gl-lamp gl-lamp-stop" />
            <i className="gl-lamp gl-lamp-hold" />
            <i className="gl-lamp gl-lamp-go" />
          </span>
          <h1 className="font-display text-base font-bold uppercase tracking-[0.14em] text-white">
            Greenlight
          </h1>
          <p className="hidden text-sm text-go-100/60 md:block">
            An IT agent that acts instantly when policy allows — and asks a human when it doesn&apos;t.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1 text-xs font-medium text-go-100">
          <i className="gl-lamp gl-lamp-go gl-lamp-static" aria-hidden />
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
