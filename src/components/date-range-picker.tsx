import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, startOfDay, endOfDay, subDays } from "date-fns";
import type { DateRange } from "react-day-picker";

interface DateRangePickerProps {
  range: DateRange;
  onChange: (range: DateRange) => void;
  /** Preset day buttons (e.g. [7, 30, 90, 365]). */
  presets?: number[];
  /** Number of currently-selected days, used to highlight the active preset. */
  activeDays?: number;
  align?: "start" | "center" | "end";
}

/**
 * Shared date-range picker: a row of preset "Nd" buttons + a two-month
 * calendar popover. Used by analytics dashboards.
 */
export function DateRangePicker({
  range,
  onChange,
  presets = [7, 30, 90, 365],
  activeDays,
  align = "end",
}: DateRangePickerProps) {
  return (
    <div className="flex gap-2 flex-wrap items-center">
      {presets.map((d) => (
        <Button
          key={d}
          size="sm"
          variant={activeDays === d ? "default" : "outline"}
          onClick={() =>
            onChange({ from: startOfDay(subDays(new Date(), d - 1)), to: endOfDay(new Date()) })
          }
        >
          {d}d
        </Button>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("justify-start text-left font-normal", !range.from && "text-muted-foreground")}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {range.from
              ? range.to
                ? `${format(range.from, "dd/MM/yyyy")} – ${format(range.to, "dd/MM/yyyy")}`
                : format(range.from, "dd/MM/yyyy")
              : "Pick a date range"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align={align}>
          <Calendar
            mode="range"
            selected={range}
            onSelect={(r) => r && onChange(r)}
            numberOfMonths={2}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
