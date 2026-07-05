import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useTheme } from "@/providers/theme-provider";
import { useBreadcrumb } from "@/contexts/breadcrumb-context";
import { SwatchIcon, CpuChipIcon, KeyIcon } from "@/components/icons/lucide";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Tabs, TabList, Tab, TabPanel } from "@/components/ui/tabs";
import { ProviderSettings } from "@/components/provider-settings";

const themes = [
  { id: "light", title: "Light" },
  { id: "dark", title: "Dark" },
  { id: "system", title: "System" },
];

function ThemeSetting() {
  const { theme, setTheme } = useTheme();

  return (
    <Select
      value={theme}
      onChange={(value) =>
        value && setTheme(value as "light" | "dark" | "system")
      }
      placeholder="Select theme"
    >
      <SelectTrigger className="max-w-sm" />
      <SelectContent>
        {themes.map((item) => (
          <SelectItem key={item.id} id={item.id} textValue={item.title}>
            {item.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// User-scoped, independent of any paired machine (see docs/superpowers/
// plans/2026-07-05-image-generation.md, Task 4). `/_app.tsx`'s layout
// bypasses its "no machine selected -> redirect to /machines" gate for
// this exact pathname so the page renders even with zero machines paired
// -- the Provider tab below has nothing to do with any machine.
export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

const models = [
  { id: "claude-3-5-sonnet", title: "Claude 3.5 Sonnet" },
  { id: "gpt-4o", title: "GPT-4o" },
  { id: "claude-3-opus", title: "Claude 3 Opus" },
];

function SettingsPage() {
  const { setPageTitle } = useBreadcrumb();
  const [selectedModel, setSelectedModel] = React.useState<string | null>(
    "claude-3-5-sonnet",
  );

  React.useEffect(() => {
    setPageTitle("Settings");
    return () => setPageTitle(null);
  }, [setPageTitle]);

  return (
    <div className="container mx-auto space-y-8 px-4 py-10">
      <div className="space-y-2">
        <h1 className="bg-gradient-to-r from-fg to-muted-fg bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
          Settings
        </h1>
        <p className="text-lg text-muted-fg">
          Manage your interface preferences and configurations.
        </p>
      </div>

      <Tabs aria-label="Settings">
        <TabList>
          <Tab id="appearance">
            <SwatchIcon className="size-4" data-slot="icon" />
            Appearance
          </Tab>
          <Tab id="model">
            <CpuChipIcon className="size-4" data-slot="icon" />
            Model
          </Tab>
          <Tab id="provider">
            <KeyIcon className="size-4" data-slot="icon" />
            Provider
          </Tab>
        </TabList>

        <TabPanel id="appearance" className="pt-6">
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Appearance</h2>
              <p className="text-sm text-muted-fg">
                Customize the visual experience of Mando.
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <p className="text-sm font-medium">Theme Preference</p>
                <p className="text-xs text-muted-fg">
                  Switch between light, dark, or system modes.
                </p>
                <ThemeSetting />
              </div>
            </div>
          </div>
        </TabPanel>

        <TabPanel id="model" className="pt-6">
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Model Configuration</h2>
              <p className="text-sm text-muted-fg">
                Select the AI model that powers your assistant.
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <p className="text-sm font-medium">Default Model</p>
                <p className="text-xs text-muted-fg">
                  The model used for generating code and responses.
                </p>
                <Select
                  value={selectedModel}
                  onChange={(value) =>
                    setSelectedModel(value?.toString() ?? null)
                  }
                  placeholder="Select a model"
                >
                  <SelectTrigger className="max-w-sm" />
                  <SelectContent>
                    {models.map((item) => (
                      <SelectItem
                        key={item.id}
                        id={item.id}
                        textValue={item.title}
                      >
                        {item.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Temperature</p>
                <p className="text-xs text-muted-fg">
                  Controls randomness in the model's output.
                </p>
                <div className="flex h-9 w-fit items-center rounded-lg border border-input px-3 text-sm text-muted-fg bg-muted/5">
                  0.7
                </div>
              </div>
            </div>
          </div>
        </TabPanel>

        <TabPanel id="provider" className="pt-6">
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Image Provider</h2>
              <p className="text-sm text-muted-fg">
                Connect your own OpenAI-compatible image provider. The base
                URL and API key are used by the Images section to generate
                and edit images; the key is encrypted at rest and never
                shown again once saved.
              </p>
            </div>

            <ProviderSettings />
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
