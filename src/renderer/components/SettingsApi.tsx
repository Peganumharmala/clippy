import React, { useEffect, useState } from "react";
import { clippyApi } from "../clippyApi";
import { useSharedState } from "../contexts/SharedStateContext";
import { Checkbox } from "./Checkbox";
import { API_PROVIDERS, ApiProvider } from "../../models";

export const SettingsApi: React.FC = () => {
  const { settings } = useSharedState();
  const [tempApiKey, setTempApiKey] = useState(settings.apiKey || "");
  const [tempModelId, setTempModelId] = useState(settings.apiModelId || "");
  const [showKey, setShowKey] = useState(false);

  const provider = settings.apiProvider || "openai";
  const providerConfig = API_PROVIDERS[provider];

  useEffect(() => {
    setTempApiKey(settings.apiKey || "");
    setTempModelId(settings.apiModelId || "");
  }, [settings.apiProvider]);

  const handleToggleApi = (checked: boolean) => {
    clippyApi.setState("settings.useApiModel", checked);
    if (checked && !settings.apiProvider) {
      clippyApi.setState("settings.apiProvider", "openai");
    }
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newProvider = e.target.value as ApiProvider;
    clippyApi.setState("settings.apiProvider", newProvider);
    clippyApi.setState("settings.apiModelId", "");
    clippyApi.setState("settings.apiKey", "");
    setTempApiKey("");
    setTempModelId("");
  };

  const handleSaveModel = () => {
    const trimmed = tempModelId.trim();
    if (trimmed) {
      clippyApi.setState("settings.apiModelId", trimmed);
    }
  };

  const handleSaveKey = () => {
    clippyApi.setState("settings.apiKey", tempApiKey.trim());
  };

  const isConfigured =
    settings.useApiModel && settings.apiKey && settings.apiModelId;

  return (
    <div>
      <fieldset>
        <legend>Cloud API</legend>
        <p>
          Use a cloud LLM provider instead of a local model. Requires an API
          key from the provider.
        </p>
        <Checkbox
          id="useApiModel"
          label="Use cloud API instead of local model"
          checked={!!settings.useApiModel}
          onChange={handleToggleApi}
        />
      </fieldset>

      {settings.useApiModel && (
        <>
          <fieldset style={{ marginTop: "10px" }}>
            <legend>Provider</legend>
            <div className="field-row">
              <label htmlFor="apiProvider">Provider:</label>
              <select
                id="apiProvider"
                value={provider}
                onChange={handleProviderChange}
              >
                {Object.entries(API_PROVIDERS).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.label}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <fieldset style={{ marginTop: "10px" }}>
            <legend>Model</legend>
            <div className="field-row-stacked">
              <label htmlFor="apiModelId">
                Enter the model ID from {providerConfig.label}:
              </label>
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  id="apiModelId"
                  type="text"
                  value={tempModelId}
                  onChange={(e) => setTempModelId(e.target.value)}
                  style={{ flex: 1 }}
                  placeholder={providerConfig.placeholder}
                />
                <button
                  onClick={handleSaveModel}
                  disabled={!tempModelId.trim()}
                >
                  Use
                </button>
              </div>
              {settings.apiModelId && (
                <span style={{ fontSize: "11px", marginTop: "4px" }}>
                  Active: {settings.apiModelId}
                </span>
              )}
            </div>
          </fieldset>

          <fieldset style={{ marginTop: "10px" }}>
            <legend>API Key</legend>
            <div className="field-row-stacked">
              <label htmlFor="apiKey">
                {providerConfig.label} API Key:
              </label>
              <div style={{ display: "flex", gap: "4px" }}>
                <input
                  id="apiKey"
                  type={showKey ? "text" : "password"}
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  style={{ flex: 1 }}
                  placeholder="Paste your API key here"
                />
                <button onClick={() => setShowKey(!showKey)}>
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div
              style={{
                marginTop: "8px",
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <button
                onClick={handleSaveKey}
                disabled={!tempApiKey.trim()}
              >
                Save Key
              </button>
              {settings.apiKey && (
                <span style={{ color: "green", fontSize: "11px" }}>
                  Key saved
                </span>
              )}
            </div>
          </fieldset>

          <fieldset style={{ marginTop: "10px" }}>
            <legend>Status</legend>
            <p>
              {isConfigured
                ? `Ready to chat using ${providerConfig.label} (${settings.apiModelId}).`
                : "Please select a provider, enter a model ID, and your API key to get started."}
            </p>
          </fieldset>
        </>
      )}
    </div>
  );
};
