import { ContextSubmenuItem } from "core";
import { createContext, useRef } from "react";
import {
  deduplicateArray,
  getBasename,
  getUniqueFilePath,
  groupByLastNPathParts,
} from "core/util";
import MiniSearch, { SearchResult } from "minisearch";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { IdeMessengerContext } from "./IdeMessenger";
import { selectContextProviderDescriptions } from "../redux/selectors";
import { RootState } from "../redux/store";
import { useWebviewListener } from "../hooks/useWebviewListener";

const MINISEARCH_OPTIONS = {
  prefix: true,
  fuzzy: 2,
};

const MAX_LENGTH = 70;

export interface ContextSubmenuItemWithProvider extends ContextSubmenuItem {
  providerTitle: string;
}

interface SubtextContextProvidersContextType {
  getSubmenuContextItems: (
    providerTitle: string | undefined,
    query: string,
  ) => (ContextSubmenuItem & { providerTitle: string })[];
  addItem: (providerTitle: string, item: ContextSubmenuItem) => void;
}

const initialContextProviders: SubtextContextProvidersContextType = {
  getSubmenuContextItems: () => [],
  addItem: () => {},
};

const SubmenuContextProvidersContext =
  createContext<SubtextContextProvidersContextType>(initialContextProviders);

export const SubmenuContextProvidersProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [mounted, setMounted] = useState(false);
  const [fetching, setFetching] = useState(false);
  // Use useRef for mutable objects that shouldn't trigger re-renders
  const minisearchesRef = useRef<{ [id: string]: MiniSearch }>({});
  const fallbackResultsRef = useRef<{ [id: string]: ContextSubmenuItem[] }>({});

  const contextProviderDescriptions = useSelector(
    selectContextProviderDescriptions,
  );
  const disableIndexing = useSelector(
    (store: RootState) => store.state.config.disableIndexing,
  );

  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [autoLoadTriggered, setAutoLoadTriggered] = useState(false);

  const ideMessenger = useContext(IdeMessengerContext);

  const getOpenFilesItems = useCallback(async () => {
    const openFiles = await ideMessenger.ide.getOpenFiles();
    const openFileGroups = groupByLastNPathParts(openFiles, 2);
    return openFiles.map(
      (file) =>
        ({
          id: file,
          title: getBasename(file),
          description: getUniqueFilePath(file, openFileGroups),
          providerTitle: "file",
        }) as ContextSubmenuItemWithProvider,
    );
  }, [ideMessenger]);

  useWebviewListener("refreshSubmenuItems", async () => {
    if (!isLoading) {
      setInitialLoadComplete(false);
      setAutoLoadTriggered((prev) => !prev);
    }
  });

  useWebviewListener("updateSubmenuItems", async (data) => {
    const minisearch = new MiniSearch<ContextSubmenuItem>({
      fields: ["title", "description"],
      storeFields: ["id", "title", "description"],
    });

    minisearch.addAll(data.submenuItems);
    minisearchesRef.current[data.provider] = minisearch;

    if (data.provider === "file") {
      const openFiles = await getOpenFilesItems();
      fallbackResultsRef.current[data.provider] = [
        ...openFiles,
        ...data.submenuItems.slice(0, MAX_LENGTH - openFiles.length),
      ];
    } else {
      fallbackResultsRef.current[data.provider] = data.submenuItems.slice(
        0,
        MAX_LENGTH,
      );
    }
  });

  const addItem = useCallback(
    (providerTitle: string, item: ContextSubmenuItem) => {
      const minisearch = minisearchesRef.current[providerTitle];
      if (!minisearch) return;
      minisearch.add(item);
    },
    [],
  );

  useEffect(() => {
    if (mounted) {
      return;
    }
    setMounted(true);
    const refreshOpenFiles = async () => {
      if (fetching) return;
      setFetching(true);
      try {
        const openFiles = await getOpenFilesItems();
        const currentFiles = fallbackResultsRef.current.file || [];
        for (const file of currentFiles) {
          if (!openFiles.some((openFile) => openFile.id === file.id)) {
            openFiles.push({ ...file, providerTitle: "file" });
          }
        }
        fallbackResultsRef.current.file = deduplicateArray(
          openFiles,
          (a, b) => a.id === b.id,
        );
      } finally {
        setFetching(false);
      }
    };
    const interval = setInterval(refreshOpenFiles, 2000);
    refreshOpenFiles();
    return () => {
      setMounted(false);
      clearInterval(interval);
    };
  }, []);

  const getSubmenuSearchResults = useCallback(
    (providerTitle: string | undefined, query: string): SearchResult[] => {
      if (providerTitle === undefined) {
        const results: SearchResult[] = [];
        Object.entries(minisearchesRef.current).forEach(
          ([provider, minisearch]) => {
            const searchResults = minisearch.search(query, MINISEARCH_OPTIONS);
            searchResults.forEach((result) => {
              results.push({ ...result, providerTitle: provider });
            });
          },
        );
        results.sort((a, b) => b.score - a.score);
        return results;
      }

      const minisearch = minisearchesRef.current[providerTitle];
      if (!minisearch) return [];

      return minisearch
        .search(query, MINISEARCH_OPTIONS)
        .map((result) => ({ ...result, providerTitle }));
    },
    [],
  );

  const getSubmenuContextItems = useCallback(
    (
      providerTitle: string | undefined,
      query: string,
      limit: number = MAX_LENGTH,
    ): (ContextSubmenuItem & { providerTitle: string })[] => {
      try {
        const results = getSubmenuSearchResults(providerTitle, query);
        if (results.length === 0) {
          const fallbackItems = fallbackResultsRef.current[providerTitle] || [];
          if (fallbackItems.length === 0 && !initialLoadComplete) {
            return [
              {
                id: "loading",
                title: "Loading...",
                description: "Please wait while items are being loaded",
                providerTitle: providerTitle || "unknown",
              },
            ];
          }
          return fallbackItems.slice(0, limit).map((result) => ({
            ...result,
            providerTitle,
          }));
        }

        return results.slice(0, limit).map((result) => ({
          id: result.id,
          title: result.title,
          description: result.description,
          providerTitle: result.providerTitle,
        }));
      } catch (error) {
        console.error("Error in getSubmenuContextItems:", error);
        return [];
      }
    },
    [getSubmenuSearchResults, initialLoadComplete],
  );

  useEffect(() => {
    if (contextProviderDescriptions.length === 0 || isLoading) {
      return;
    }
    setIsLoading(true);

    const loadSubmenuItems = async () => {
      try {
        await Promise.all(
          contextProviderDescriptions.map(async (description) => {
            const shouldSkipProvider =
              description.dependsOnIndexing && disableIndexing;

            if (shouldSkipProvider) {
              console.debug(
                `Skipping ${description.title} provider due to disabled indexing`,
              );
              return;
            }

            try {
              const minisearch = new MiniSearch<ContextSubmenuItem>({
                fields: ["title", "description"],
                storeFields: ["id", "title", "description"],
              });

              const result = await ideMessenger.request(
                "context/loadSubmenuItems",
                {
                  title: description.title,
                },
              );

              if (result.status === "error") {
                console.error(
                  `Error loading items for ${description.title}:`,
                  result.error,
                );
                return;
              }
              const items = result.content;

              minisearch.addAll(items);
              minisearchesRef.current[description.title] = minisearch;
              // setMinisearches((prev) => ({
              //   ...prev,
              //   [description.title]: minisearch,
              // }));

              if (description.title === "file") {
                const openFiles = await getOpenFilesItems();
                // setFallbackResults((prev) => ({
                //   ...prev,
                //   file: [
                //     ...openFiles,
                //     ...items.slice(0, MAX_LENGTH - openFiles.length),
                //   ],
                // }));
                fallbackResultsRef.current.file = [
                  ...openFiles,
                  ...items.slice(0, MAX_LENGTH - openFiles.length),
                ];
              } else {
                // setFallbackResults((prev) => ({
                //   ...prev,
                //   [description.title]: items.slice(0, MAX_LENGTH),
                // }));
                fallbackResultsRef.current[description.title] = items.slice(
                  0,
                  MAX_LENGTH,
                );
              }
            } catch (error) {
              console.error(`Error processing ${description.title}:`, error);
              console.error(
                "Error details:",
                JSON.stringify(error, Object.getOwnPropertyNames(error)),
              );
            }
          }),
        );
      } catch (error) {
        console.error("Error in loadSubmenuItems:", error);
      } finally {
        setInitialLoadComplete(true);
        setIsLoading(false);
      }
    };

    loadSubmenuItems();
  }, [
    contextProviderDescriptions,
    autoLoadTriggered,
    disableIndexing,
    getOpenFilesItems,
    ideMessenger,
  ]);

  return (
    <SubmenuContextProvidersContext.Provider
      value={{
        getSubmenuContextItems,
        addItem,
      }}
    >
      {children}
    </SubmenuContextProvidersContext.Provider>
  );
};

export const useSubmenuContextProviders = () =>
  useContext(SubmenuContextProvidersContext);
