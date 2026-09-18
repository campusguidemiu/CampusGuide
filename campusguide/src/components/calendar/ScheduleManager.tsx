"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Loader2, CheckCircle, AlertCircle, Download } from "lucide-react";
import { SCHEDULE_CSV_HEADERS, SCHEDULE_CSV_TEMPLATE } from "@/lib/scheduleCsvFormat";

export function ScheduleManager({ onUpdate }: { onUpdate: () => void }) {
    const [open, setOpen] = React.useState(false);
    const [mode, setMode] = React.useState<"manual" | "csv">("manual");
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

    // Manual Form State
    const [title, setTitle] = React.useState("");
    const [type, setType] = React.useState<"lecture" | "lab">("lecture");
    const [dow, setDow] = React.useState("SA");
    const [start, setStart] = React.useState("09:00");
    const [end, setEnd] = React.useState("10:00");
    const [prof, setProf] = React.useState("");
    const [room, setRoom] = React.useState("");

    function reset() {
        setMsg(null);
        setBusy(false);
        setMode("manual");
        setTitle("");
        setProf("");
        setRoom("");
    }

    async function sendRows(rows: unknown[]) {
        const res = await fetch("/api/student/schedule/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ rows }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? "Failed to save your schedule");
        return Number(body?.imported ?? rows.length);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setMsg(null);

        if (end <= start) {
            setMsg({ type: "error", text: "End time must be after start time." });
            return;
        }

        setBusy(true);

        const row = {
            title,
            type,
            dayOfWeek: dow,
            startTime: start,
            endTime: end,
            professor: prof || undefined,
            roomCode: room || undefined,
        };

        try {
            await sendRows([row]);
            setMsg({ type: "success", text: "Class added successfully!" });
            onUpdate();
            window.dispatchEvent(new Event("cg:calendar:refetch"));
            setTitle("");
            setProf("");
            setRoom("");
        } catch (err) {
            setMsg({ type: "error", text: err instanceof Error ? err.message : "Network error. Please try again." });
        } finally {
            // Without a finally the button stays disabled forever on a failed request.
            setBusy(false);
        }
    }

    async function handleCsv(file: File) {
        setMsg(null);
        setBusy(true);

        try {
            // Loaded here rather than at module scope: the parser drags in
            // papaparse, which no one needs until a file is actually chosen.
            const { parseScheduleCsv } = await import("@/lib/scheduleCsv");
            const parsed = parseScheduleCsv(await file.text());
            if (!parsed.ok) {
                setMsg({ type: "error", text: parsed.error });
                return;
            }

            const imported = await sendRows(parsed.rows);
            const skipped = parsed.skipped ? ` ${parsed.skipped} empty row${parsed.skipped > 1 ? "s were" : " was"} skipped.` : "";
            setMsg({ type: "success", text: `Imported ${imported} class${imported === 1 ? "" : "es"} into your calendar.${skipped}` });
            onUpdate();
            window.dispatchEvent(new Event("cg:calendar:refetch"));
        } catch (err) {
            setMsg({ type: "error", text: err instanceof Error ? err.message : "Import failed. Check the file and your connection." });
        } finally {
            setBusy(false);
        }
    }

    function downloadTemplate() {
        const url = URL.createObjectURL(new Blob([SCHEDULE_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "campusguide-schedule-template.csv";
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <Dialog open={open} onOpenChange={(v: boolean) => { setOpen(v); if (v) reset(); }}>
            <DialogTrigger asChild>
                <Button variant="outline" className="w-full gap-2 sm:w-auto">
                    <Plus className="h-4 w-4" />
                    Add Class
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-105 bg-panel text-foreground border border-foreground/10 shadow-xl shadow-primary/10">
                <DialogHeader>
                    <DialogTitle className="text-foreground">Add Class</DialogTitle>
                    <DialogDescription className="text-foreground/70">Add one class, or import your whole timetable from a CSV file.</DialogDescription>
                </DialogHeader>

                <div className="flex gap-1 rounded-xl border border-foreground/10 bg-background/40 p-1">
                    {([["manual", "One class"], ["csv", "Import CSV"]] as const).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => { setMode(value); setMsg(null); }}
                            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${mode === value ? "bg-primary text-white shadow-sm" : "text-foreground/70 hover:text-foreground"}`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {msg && (
                    <div className={`p-3 rounded-xl text-sm flex items-start gap-2 border ${msg.type === "success" ? "bg-success/10 text-foreground border-success/25" : "bg-risk/10 text-foreground border-risk/25"}`}>
                        {msg.type === "success" ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                        {msg.text}
                    </div>
                )}

                {mode === "csv" ? (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-foreground/80">Schedule file (.csv)</label>
                            <Input
                                type="file"
                                accept=".csv,text/csv"
                                disabled={busy}
                                onChange={e => {
                                    const file = e.target.files?.[0];
                                    // Clearing lets the same file be picked again after a failed import.
                                    e.currentTarget.value = "";
                                    if (file) handleCsv(file);
                                }}
                                className="bg-background/40 border-foreground/15 text-foreground focus:ring-accent/40"
                            />
                        </div>

                        <div className="rounded-xl border border-foreground/10 bg-background/40 p-3">
                            <p className="text-xs font-semibold text-foreground/80">Columns</p>
                            <p className="mt-1 break-words font-mono text-[11px] text-foreground/70">
                                {SCHEDULE_CSV_HEADERS.join(",")}
                            </p>
                            <p className="mt-2 text-[11px] leading-relaxed text-foreground/60">
                                Room and professor are optional. Type is lecture or lab, day is MO–SU (or Monday, Tue…),
                                and times are 24-hour HH:MM. Every class repeats weekly.
                            </p>
                        </div>

                        <Button type="button" variant="secondary" className="w-full gap-2" onClick={downloadTemplate}>
                            <Download className="h-4 w-4" />
                            Download template
                        </Button>

                        {busy && (
                            <p className="flex items-center justify-center gap-2 text-xs text-foreground/70">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Importing…
                            </p>
                        )}
                    </div>
                ) : (
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs font-semibold text-foreground/80">Course Title</label>
                        <Input
                            required
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="e.g. Data Structures & Algorithms"
                            className="bg-background/40 border-foreground/15 text-foreground placeholder:text-foreground/50 focus:ring-accent/40"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-foreground/80">Type</label>
                            <Select
                                value={type}
                                onChange={e => setType(e.target.value as any)}
                                className="bg-background/40 border-foreground/15 text-foreground focus:ring-accent/40"
                            >
                                <option value="lecture">Lecture</option>
                                <option value="lab">Lab</option>
                            </Select>
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-foreground/80">Day</label>
                            <Select
                                value={dow}
                                onChange={e => setDow(e.target.value)}
                                className="bg-background/40 border-foreground/15 text-foreground focus:ring-accent/40"
                            >
                                <option value="SA">Saturday</option>
                                <option value="SU">Sunday</option>
                                <option value="MO">Monday</option>
                                <option value="TU">Tuesday</option>
                                <option value="WE">Wednesday</option>
                                <option value="TH">Thursday</option>
                                <option value="FR">Friday</option>
                            </Select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-foreground/80">Start Time</label>
                            <Input
                                required
                                type="time"
                                value={start}
                                onChange={e => setStart(e.target.value)}
                                className="bg-background/40 border-foreground/15 text-foreground focus:ring-accent/40"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-semibold text-foreground/80">End Time</label>
                            <Input
                                required
                                type="time"
                                value={end}
                                onChange={e => setEnd(e.target.value)}
                                className="bg-background/40 border-foreground/15 text-foreground focus:ring-accent/40"
                            />
                        </div>
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-semibold text-foreground/80">Professor (optional)</label>
                        <Input
                            value={prof}
                            onChange={e => setProf(e.target.value)}
                            placeholder="Dr. Ahmed Hassan"
                            className="bg-background/40 border-foreground/15 text-foreground placeholder:text-foreground/50 focus:ring-accent/40"
                        />
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-semibold text-foreground/80">Room (optional)</label>
                        <Input
                            value={room}
                            onChange={e => setRoom(e.target.value)}
                            placeholder="e.g. 204, RC1 or LABK"
                            className="bg-background/40 border-foreground/15 text-foreground placeholder:text-foreground/50 focus:ring-accent/40"
                        />
                    </div>

                    <Button type="submit" className="w-full shadow-lg shadow-primary/20" disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Class"}
                    </Button>
                </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
