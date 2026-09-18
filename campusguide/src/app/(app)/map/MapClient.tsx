"use client";

import * as React from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MapPin, Search } from "lucide-react";
import { SCHEDULE_CSV_HEADERS, SCHEDULE_CSV_TEMPLATE } from "@/lib/scheduleCsvFormat";
import { findRoomByCode, matchScheduleRooms } from "@/lib/rooms";

type Room = { roomCode: string; building: string; floor: number; x: number; y: number };

type Upcoming = { title: string; type: string; start: string; end: string; roomCode: string };

export function MapClient() {
  const search = useSearchParams();
  const initialRoom = (search.get("room") ?? "").trim().toUpperCase();

  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [upcoming, setUpcoming] = React.useState<Upcoming[]>([]);
  const [scheduleRoomCodes, setScheduleRoomCodes] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Room | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [importMsg, setImportMsg] = React.useState<string | null>(null);
  const [mapImgError, setMapImgError] = React.useState(false);
  const [mapSrc, setMapSrc] = React.useState("/campus-map-v3.png");

  const transformRef = React.useRef<ReactZoomPanPinchRef | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      // "no-cache" revalidates rather than reading the browser cache: the route
      // sends max-age=30, and a CSV import calls reload() straight afterwards,
      // which would otherwise redisplay the pre-import schedule.
      const res = await fetch("/api/student/map", { cache: "no-cache" });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error ?? "Failed to load map data");
        return;
      }
      const list = (j?.rooms ?? []) as Room[];
      setRooms(list);
      setUpcoming((j?.upcoming ?? []) as Upcoming[]);
      setScheduleRoomCodes(((j?.scheduleRoomCodes ?? []) as string[]).map((c) => String(c).trim().toUpperCase()));

      if (initialRoom) {
        setSelected(findRoomByCode(list, initialRoom));
      }

      setError(null);
    } catch {
      // Without this the page stays on "Loading…" forever after a dropped request.
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [initialRoom]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const results = React.useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [] as Room[];
    return rooms
      .filter((r) => r.roomCode.includes(q) || r.building.includes(q))
      .slice(0, 20);
  }, [query, rooms]);

  // Codes come from the whole schedule when we have it, so a class further out
  // than the 7-day "upcoming" window still gets a pin.
  const { placed: upcomingRooms, unknown: unplacedCodes } = React.useMemo(
    () => matchScheduleRooms(rooms, scheduleRoomCodes.length ? scheduleRoomCodes : upcoming.map((e) => e.roomCode)),
    [upcoming, rooms, scheduleRoomCodes]
  );

  async function onImportCsv(file: File) {
    setImportMsg(null);
    setImporting(true);

    try {
      // Loaded here rather than at module scope: the parser drags in papaparse,
      // and the map is a page most students open without ever importing a file.
      const { parseScheduleCsv } = await import("@/lib/scheduleCsv");
      const parsed = parseScheduleCsv(await file.text());
      if (!parsed.ok) {
        setImportMsg(parsed.error);
        return;
      }

      const res = await fetch("/api/student/schedule/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setImportMsg(j?.error ?? "Import failed");
        return;
      }

      const imported = Number(j?.imported ?? parsed.rows.length);
      const codes = parsed.rows.map((r) => r.roomCode).filter(Boolean) as string[];
      const { placed, unknown } = matchScheduleRooms(rooms, codes);

      // Say what landed on the map, not just what was saved: an import with no
      // room codes looks broken otherwise, because no pins appear.
      const parts = [`Imported ${imported} class${imported === 1 ? "" : "es"} into your calendar.`];
      if (!codes.length) {
        parts.push("None of the rows had a roomCode, so there is nothing to pin on the map.");
      } else if (placed.length) {
        parts.push(`${placed.length} room${placed.length === 1 ? "" : "s"} pinned below.`);
      }
      if (unknown.length) {
        parts.push(`Not on the map: ${unknown.join(", ")}.`);
      }
      setImportMsg(parts.join(" "));

      window.dispatchEvent(new Event("cg:calendar:refetch"));
      await reload();
    } catch {
      setImportMsg("Import failed. Check the file and your connection.");
    } finally {
      setImporting(false);
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
    <div className="space-y-2">
      <h1 className="text-2xl font-extrabold tracking-tight">Campus Map</h1>
      <p className="text-sm text-foreground/70">Search rooms by code or building. Click to zoom and highlight.</p>

      <div className="grid gap-6 pt-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5 text-primary" />
              Find a room
            </CardTitle>
            <CardDescription>Room coordinates are image-based (not GPS).</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-foreground/70">Loading…</p>
            ) : error ? (
              <p className="text-sm font-semibold text-risk">{error}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input className="sm:flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search: C204 or building C" />
                  <Button className="w-full sm:w-auto" type="button" variant="secondary" onClick={() => setQuery("")}>Clear</Button>
                </div>

                {selected ? (
                  <div className="rounded-2xl bg-background p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-extrabold">{selected.roomCode}</p>
                        <p className="text-xs text-foreground/70">Building {selected.building} • Floor {selected.floor}</p>
                      </div>
                      <Badge tone="neutral">Selected</Badge>
                    </div>
                    <p className="mt-3 text-xs text-foreground/70">Tip: Calendar events include a room field and a “Find room on map” link.</p>
                  </div>
                ) : (
                  <p className="text-sm text-foreground/70">Select a room to see details.</p>
                )}

                {results.length ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-foreground/70">Results</p>
                    {results.map((r) => (
                      <button
                        key={r.roomCode}
                        className="flex w-full items-center justify-between gap-2 rounded-2xl bg-panel px-4 py-3 text-left transition hover:bg-panel/80"
                        onClick={() => setSelected(r)}
                      >
                        <span className="shrink-0 font-extrabold">{r.roomCode}</span>
                        <span className="min-w-0 truncate text-xs text-foreground/70">{r.building} • Floor {r.floor}</span>
                      </button>
                    ))}
                  </div>
                ) : query.trim() ? (
                  <p className="text-sm text-foreground/70">No matches.</p>
                ) : null}

                <div className="rounded-2xl border border-foreground/10 bg-background p-4">
                  <p className="text-sm font-extrabold">Your schedule on the map</p>
                  <p className="text-xs text-foreground/70">Upcoming lectures/labs (next 7 days) with a room code.</p>

                  <div className="mt-3 rounded-2xl bg-panel p-3">
                    <p className="text-xs font-semibold">Upload schedule CSV</p>
                    <p className="mt-1 text-xs text-foreground/70">
                      Headers: {SCHEDULE_CSV_HEADERS.join(",")} (type = lecture/lab, dayOfWeek = MO..SU, time = HH:mm).
                      Rows with a roomCode get a pin on the map.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        type="file"
                        accept=".csv,text/csv"
                        disabled={importing}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onImportCsv(f);
                          e.currentTarget.value = "";
                        }}
                      />
                      <Button type="button" variant="secondary" disabled={importing} onClick={downloadTemplate}>
                        Template
                      </Button>
                    </div>
                    {importing ? <p className="mt-2 text-xs font-semibold text-foreground/80">Importing…</p> : null}
                    {importMsg ? <p className="mt-2 text-xs font-semibold text-foreground/80">{importMsg}</p> : null}
                  </div>

                  {unplacedCodes.length ? (
                    <div className="mt-3 rounded-2xl border border-risk/25 bg-risk/10 p-3">
                      <p className="text-xs font-semibold">
                        {unplacedCodes.length} room code{unplacedCodes.length === 1 ? " is" : "s are"} not on the map
                      </p>
                      <p className="mt-1 break-words font-mono text-[11px] text-foreground/70">{unplacedCodes.join(", ")}</p>
                      <p className="mt-1 text-[11px] text-foreground/60">
                        Search the code above to see how the map spells it, then fix it on the calendar event.
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-3 space-y-2">
                    {upcomingRooms.length ? (
                      <>
                        <p className="text-xs font-semibold text-foreground/70">Your rooms</p>
                        <div className="flex flex-wrap gap-2">
                          {upcomingRooms.map((r) => (
                            <button
                              key={`chip-${r.roomCode}`}
                              type="button"
                              className={`rounded-xl px-3 py-1.5 text-xs font-extrabold transition ${selected?.roomCode === r.roomCode ? "bg-primary text-white" : "bg-panel hover:bg-panel/80"}`}
                              onClick={() => setSelected(r)}
                            >
                              {r.roomCode}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {upcoming.length === 0 ? (
                      <p className="text-sm text-foreground/70">
                        Import a CSV above, or add room codes to your calendar events, to see your classes here.
                      </p>
                    ) : (
                      upcoming.slice(0, 6).map((e, idx) => (
                        <button
                          key={idx}
                          className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl bg-panel px-3 py-2 text-left hover:bg-panel/80"
                          onClick={() => setSelected(findRoomByCode(rooms, e.roomCode))}
                        >
                          <span className="truncate text-sm font-semibold">{e.title}</span>
                          <span className="shrink-0 text-xs font-extrabold text-primary">{e.roomCode}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              Interactive map
            </CardTitle>
            <CardDescription>
              Use pinch/scroll to zoom. Select a room to highlight it on the map.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mx-auto w-full max-w-150 overflow-hidden rounded-2xl border border-foreground/10 bg-background">
              <TransformWrapper
                ref={transformRef}
                initialScale={1}
                minScale={0.5}
                maxScale={8}
                centerOnInit
                wheel={{ step: 0.15 }}
                doubleClick={{ disabled: true }}
              >
                {({ zoomIn, zoomOut, resetTransform }) => (
                  <>
                    <div className="flex flex-wrap items-center gap-2 border-b border-foreground/10 p-3">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => (transformRef.current?.zoomIn ? transformRef.current.zoomIn() : zoomIn())}
                      >
                        +
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => (transformRef.current?.zoomOut ? transformRef.current.zoomOut() : zoomOut())}
                      >
                        −
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => (transformRef.current?.resetTransform ? transformRef.current.resetTransform() : resetTransform())}
                      >
                        Reset
                      </Button>
                    </div>

                    <TransformComponent
                      wrapperStyle={{ width: "100%", height: "100%" }}
                      contentStyle={{ width: "100%" }}
                    >
                      <div className="relative w-full aspect-square bg-muted/20">
                        {!mapImgError ? (
                          <Image
                            src={mapSrc}
                            alt="Campus map"
                            fill
                            priority
                            onError={() => {
                              // Try fallback if v3 is missing, otherwise show placeholder.
                              if (mapSrc === "/campus-map-v3.png") {
                                setMapSrc("/campus-map.png");
                                return;
                              }
                              setMapImgError(true);
                            }}
                            className="object-contain select-none"
                            sizes="100vw"
                            quality={75}
                          />
                        ) : (
                          <div className="grid aspect-square w-full place-items-center bg-panel p-8 text-center">
                            <div>
                              <p className="text-sm font-extrabold">Map image not found</p>
                              <p className="mt-1 text-xs text-foreground/70">
                                Add your campus map image at <span className="font-semibold">public/campus-map-v3.png</span> (or <span className="font-semibold">public/campus-map.png</span>).
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Schedule markers */}
                        {upcomingRooms.map((r) => (
                          <div
                            key={`up-${r.roomCode}`}
                            className="absolute -translate-x-1/2 -translate-y-1/2"
                            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }}
                          >
                            <button
                              type="button"
                              onClick={() => setSelected(r)}
                              className="h-4 w-4 rounded-full bg-secondary shadow-sm ring-4 ring-secondary/30"
                              title={`Scheduled: ${r.roomCode}`}
                              aria-label={`Select ${r.roomCode}`}
                            />
                          </div>
                        ))}

                        {/* Selected marker (Absolute positioned wrapper with zero size to prevent offset) */}
                        {selected ? (
                          <div
                            className="absolute z-10"
                            style={{ left: `${selected.x * 100}%`, top: `${selected.y * 100}%` }}
                          >
                            <div className="relative flex flex-col items-center">
                              {/* The pin visual - centered on the coordinate */}
                              <div className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2">
                                <span className="flex h-5 w-5 rounded-full bg-primary shadow-sm ring-4 ring-primary/30" />
                                <span className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/60" />
                              </div>

                              {/* Tooltip - positioned below the pin */}
                              <div className="absolute -top-3 z-20 flex w-max max-w-50 -translate-y-full flex-col items-center">
                                <div className="rounded-xl bg-nav px-3 py-2 text-xs font-semibold text-white shadow-lg">
                                  {selected.roomCode} • {selected.building} • Floor {selected.floor}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </TransformComponent>
                  </>
                )}
              </TransformWrapper>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
