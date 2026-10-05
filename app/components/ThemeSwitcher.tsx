import { Monitor, Moon, Sun } from "lucide-react";
import { setThemeChoice, useTheme, type ThemeChoice } from "@/lib/theme";
import { Segmented } from "@/components/ui/segmented";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * System, light or dark. `compact` drops the words for the header menu, where the
 * icons sit under a heading that already says what they are.
 */
export function ThemeSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { choice } = useTheme();
  return (
    <Segmented
      label="Theme"
      value={choice}
      onChange={setThemeChoice}
      className={className}
      size={compact ? "sm" : "md"}
      options={OPTIONS.map(({ value, label, icon: Icon }) => ({
        value,
        title: compact ? label : undefined,
        label: compact ? (
          <>
            <Icon aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </>
        ) : (
          <>
            <Icon aria-hidden="true" />
            {label}
          </>
        ),
      }))}
    />
  );
}
