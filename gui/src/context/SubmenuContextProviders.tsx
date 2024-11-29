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
  const [minisearches, setMinisearches] = useState<{
    [id: string]: MiniSearch;
  }>({});
  const [fallbackResults, setFallbackResults] = useState<{
    [id: string]: ContextSubmenuItem[];
  }>({});

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
      setAutoLoadTriggered((prev) => !prev); // Toggle to trigger effect
    }
  });

  useWebviewListener("updateSubmenuItems", async (data) => {
    const minisearch = new MiniSearch<ContextSubmenuItem>({
      fields: ["title", "description"],
      storeFields: ["id", "title", "description"],
    });

    minisearch.addAll(data.submenuItems);
    setMinisearches((prev) => ({ ...prev, [data.provider]: minisearch }));

    if (data.provider === "file") {
      const openFiles = await getOpenFilesItems();
      setFallbackResults((prev) => ({
        ...prev,
        file: [
          ...openFiles,
          ...data.submenuItems.slice(0, MAX_LENGTH - openFiles.length),
        ],
      }));
    } else {
      setFallbackResults((prev) => ({
        ...prev,
        [data.provider]: data.submenuItems.slice(0, MAX_LENGTH),
      }));
    }
  });

  const addItem = useCallback(
    (providerTitle: string, item: ContextSubmenuItem) => {
      if (!minisearches[providerTitle]) {
        return;
      }
      minisearches[providerTitle].add(item);
    },
    [minisearches],
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
        const currentFiles = fallbackResults.file || [];
        for (const file of currentFiles) {
          if (!openFiles.some((openFile) => openFile.id === file.id)) {
            openFiles.push({ ...file, providerTitle: "file" });
          }
        }
        fallbackResults.file = deduplicateArray(
          openFiles,
          (a, b) => a.id === b.id,
        );
        setFallbackResults(fallbackResults);
      } finally {
        setFetching(false);
      }
    };
    const interval = setInterval(refreshOpenFiles, 2000);

    refreshOpenFiles(); // Initial call\

    return () => {
      setMounted(false);
      clearInterval(interval);
    };
  }, []);

  const getSubmenuSearchResults = useMemo(
    () =>
      (providerTitle: string | undefined, query: string): SearchResult[] => {
        if (providerTitle === undefined) {
          // Return search combined from all providers
          const results = Object.keys(minisearches).map((providerTitle) => {
            const results = minisearches[providerTitle].search(
              query,
              MINISEARCH_OPTIONS,
            );
            return results.map((result) => {
              return { ...result, providerTitle };
            });
          });

          return results.flat().sort((a, b) => b.score - a.score);
        }
        if (!minisearches[providerTitle]) {
          return [];
        }

        const results = minisearches[providerTitle]
          .search(query, MINISEARCH_OPTIONS)
          .map((result) => {
            return { ...result, providerTitle };
          });

        return results;
      },
    [minisearches],
  );

  const getSubmenuContextItems = useMemo(
    () =>
      (
        providerTitle: string | undefined,
        query: string,
        limit: number = MAX_LENGTH,
      ): (ContextSubmenuItem & { providerTitle: string })[] => {
        try {
          const results = getSubmenuSearchResults(providerTitle, query);
          if (results.length === 0) {
            const fallbackItems = (fallbackResults[providerTitle] ?? [])
              .slice(0, limit)
              .map((result) => {
                return {
                  ...result,
                  providerTitle,
                };
              });

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

            return fallbackItems;
          }
          const limitedResults = results.slice(0, limit).map((result) => {
            return {
              id: result.id,
              title: result.title,
              description: result.description,
              providerTitle: result.providerTitle,
            };
          });
          return limitedResults;
        } catch (error) {
          console.error("Error in getSubmenuContextItems:", error);
          return [];
        }
      },
    [fallbackResults, getSubmenuSearchResults, initialLoadComplete],
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
              minisearches[description.title] = minisearch;
              setMinisearches(minisearches);

              if (description.title === "file") {
                const openFiles = await getOpenFilesItems();
                setFallbackResults((prev) => ({
                  ...prev,
                  file: [
                    ...openFiles,
                    ...items.slice(0, MAX_LENGTH - openFiles.length),
                  ],
                }));
              } else {
                setFallbackResults((prev) => ({
                  ...prev,
                  [description.title]: items.slice(0, MAX_LENGTH),
                }));
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
