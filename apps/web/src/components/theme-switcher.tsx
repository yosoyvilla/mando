import {
  CheckIcon,
  MoonIcon,
  SunIcon,
  ComputerDesktopIcon,
} from "@/components/icons/lucide";
import { useTheme } from "@/providers/theme-provider";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: ComputerDesktopIcon },
] as const;

// Icon-only trigger for the theme menu. MenuTrigger (see ui/menu.tsx) is
// itself the interactive button -- it must render a plain icon as its
// child, not another <Button>, or the DOM ends up with a <button> nested
// inside a <button> (invalid HTML, confusing to screen readers). See
// empty-state.tsx's session-options trigger for the same pattern.
export function ThemeSwitcher() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Theme: ${theme}. Change theme`}
        className="touch-target flex size-8 items-center justify-center rounded-md text-muted-fg outline-hidden transition-colors hover:bg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {resolvedTheme === "dark" ? (
          <MoonIcon className="size-4" aria-hidden="true" />
        ) : (
          <SunIcon className="size-4" aria-hidden="true" />
        )}
      </MenuTrigger>
      <MenuContent placement="top">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <MenuItem key={value} onAction={() => setTheme(value)}>
            <Icon className="size-4" aria-hidden="true" />
            {label}
            {theme === value && (
              <CheckIcon className="ml-auto size-4" aria-hidden="true" />
            )}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function ThemeSwitcherSimple() {
  const { resolvedTheme, setTheme } = useTheme();

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  return (
    <Button
      intent="plain"
      size="sq-sm"
      onPress={toggleTheme}
      aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
    >
      {resolvedTheme === "dark" ? (
        <MoonIcon className="size-4" />
      ) : (
        <SunIcon className="size-4" />
      )}
    </Button>
  );
}
