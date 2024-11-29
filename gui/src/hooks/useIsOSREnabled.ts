import { useState, useEffect, useContext } from "react";
import { isJetBrains } from "../util";
import { useWebviewListener } from "./useWebviewListener";
import { IdeMessengerContext } from "../context/IdeMessenger";

export default function useIsOSREnabled() {
  const [mounted, setMounted] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [isOSREnabled, setIsOSREnabled] = useState(false);
  const ideMessenger = useContext(IdeMessengerContext);

  useWebviewListener(
    "jetbrains/isOSREnabled",
    async (isOSREnabled) => {
      if (fetching) {
        setIsOSREnabled(isOSREnabled);
        setFetching(false);
      }
    },
    [mounted],
    fetching,
  );

  useEffect(() => {
    if (!mounted) {
      return;
    }
    setMounted(true);
    if (isJetBrains() && !fetching) {
      ideMessenger.post("jetbrains/isOSREnabled", undefined);
      setFetching(true);
    }
  }, []);

  return isOSREnabled;
}
