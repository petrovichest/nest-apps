import { application } from "./application";
import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { SetupScreen } from "./components/SetupScreen";
import { ConnectionProvider } from "./connection";
import { loadConnectionSettings, type ConnectionSettings } from "./storage";
import { useTheme } from "./useTheme";

export function Root() {
  const theme = useTheme();
  const [settings, setSettings] = useState<ConnectionSettings | null | undefined>(undefined);
  useEffect(() => {
    void loadConnectionSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  if (settings === undefined) return <div className="splash">{application.name}</div>;
  if (!settings) return <SetupScreen onConnected={setSettings} />;
  return (
    <ConnectionProvider settings={settings}>
      {/* Live session events must not starve user-initiated route changes. */}
      <BrowserRouter useTransitions={false}>
        <App settings={settings} onDisconnected={() => setSettings(null)} {...theme} />
      </BrowserRouter>
    </ConnectionProvider>
  );
}
