import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GoPackage } from "react-icons/go";
import { TbFileTypeXml } from "react-icons/tb";

import type {
  AdditionalFeedActionResponse,
  AdditionalFeedEntry,
  AdditionalFeedsResponse,
  AdditionalMarketOption,
} from "../routes/app.additional-feeds";
import type {
  FeedDataResponse,
  FeedMetadata,
  FeedStatus,
} from "../routes/app.feed-data";
import {
  additionalFormCombinationKey,
  availableLanguagesForForm,
  createAdditionalMarketForm,
  reconcileAdditionalMarketForms,
  selectedAdditionalFormCombinations,
  visibleAdditionalFeedEntries,
  type AdditionalMarketFormState,
} from "../services/additional-feed-forms";
import {
  configurationKeys,
  configurationQueryOptions,
  type ConfigurationResponse,
} from "../services/configuration-query";
import {
  additionalFeedsQueryOptions,
  additionalLanguagesQueryOptions,
  additionalMarketOptionsQueryOptions,
  deleteAdditionalFeed,
  feedKeys,
  generateAdditionalFeed,
  generatePrimaryFeed,
  primaryFeedQueryOptions,
  refreshAdditionalFeed,
  refreshAllFeeds,
  refreshAllStatusQueryOptions,
  type FeedQueryScope,
} from "../services/feed-query";
import { useHydrated } from "../hooks/useHydrated";
import { shouldPollPrimaryFeed } from "../services/feed-generation-state";
import styles from "../styles/feeds.module.css";
import { AutomaticRefreshCard } from "./AutomaticRefreshCard";
import { FeedStatusBadge } from "./FeedStatusBadge";
import {
  TabAlertNavigator,
  type TabAlert,
} from "./TabAlertNavigator";

interface FeedsPanelProps {
  active: boolean;
  scope: FeedQueryScope | null;
}

const pendingStatuses = new Set<FeedStatus>(["QUEUED", "PROCESSING"]);

function isSuccessfulFeedData(
  data: FeedDataResponse | undefined,
): data is Extract<FeedDataResponse, { ok: true }> {
  return data?.ok === true;
}

function hasPendingAdditionalFeeds(
  data:
    | {
        activeGeneration?: unknown;
        feeds?: AdditionalFeedEntry[];
        ok?: boolean;
      }
    | undefined,
) {
  return Boolean(
    data?.ok &&
    (data.activeGeneration ||
      data.feeds?.some(({ feed }) => pendingStatuses.has(feed.status))),
  );
}

function formatFileSize(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return null;

  const bytes = BigInt(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let divisor = 1n;

  while (unitIndex < units.length - 1 && bytes >= divisor * 1_024n) {
    divisor *= 1_024n;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${bytes.toString()} B`;
  const whole = Number((bytes * 10n) / divisor) / 10;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(whole)} ${units[unitIndex]}`;
}

function FeedFileDetails({ feed }: { feed: FeedMetadata }) {
  return (
    <span className={styles.feedFileDetails}>
      <span className={styles.feedFileDetail}>
        <GoPackage aria-hidden="true" />
        {new Intl.NumberFormat().format(feed.generatedItems)} variants
      </span>
      <span className={styles.feedFileDetail}>
        <TbFileTypeXml aria-hidden="true" />
        {formatFileSize(feed.fileSizeBytes) ?? "Size unavailable"}
      </span>
    </span>
  );
}

function formatRefreshDate(value: string, locale: string | null) {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }
}

function LoadingRow() {
  return (
    <s-table-row>
      <s-table-cell>
        <span className={styles.loadingLine} />
      </s-table-cell>
      <s-table-cell>
        <span className={styles.loadingLine} />
      </s-table-cell>
      <s-table-cell>
        <span className={`${styles.loadingLine} ${styles.loadingLineWide}`} />
      </s-table-cell>
      <s-table-cell>
        <span className={styles.loadingLine} />
      </s-table-cell>
      <s-table-cell>
        <span className={styles.loadingLine} />
      </s-table-cell>
    </s-table-row>
  );
}

function generationProgress(feed: FeedMetadata) {
  if (feed.status === "QUEUED") {
    return "Waiting for the feed worker";
  }
  if (feed.status !== "PROCESSING") {
    return null;
  }
  if (feed.totalProducts && feed.totalProducts > 0) {
    return `${new Intl.NumberFormat().format(feed.processedProducts)} of ${new Intl.NumberFormat().format(feed.totalProducts)} products`;
  }

  return feed.processedProducts > 0
    ? `${new Intl.NumberFormat().format(feed.processedProducts)} products processed`
    : "Preparing catalog";
}

interface AdditionalMarketFormProps {
  active: boolean;
  endpoint: string;
  form: AdditionalMarketFormState;
  forms: AdditionalMarketFormState[];
  generationLocked: boolean;
  isGenerating: boolean;
  progress: string | null;
  marketError: boolean;
  marketLoading: boolean;
  marketOptions: AdditionalMarketOption[];
  onGenerate: (form: AdditionalMarketFormState) => void;
  onRemove: (formId: string) => void;
  onUpdate: (
    formId: string,
    update: Partial<AdditionalMarketFormState>,
  ) => void;
  queryScope: FeedQueryScope;
  scopeReady: boolean;
}

function AdditionalMarketForm({
  active,
  endpoint,
  form,
  forms,
  generationLocked,
  isGenerating,
  progress,
  marketError,
  marketLoading,
  marketOptions,
  onGenerate,
  onRemove,
  onUpdate,
  queryScope,
  scopeReady,
}: AdditionalMarketFormProps) {
  const hydrated = useHydrated();
  const [marketSearch, setMarketSearch] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const marketSearchRef = useRef<HTMLElementTagNameMap["s-search-field"]>(null);
  const languageSearchRef =
    useRef<HTMLElementTagNameMap["s-search-field"]>(null);
  const marketPopoverId = `${form.id}-market-popover`;
  const languagePopoverId = `${form.id}-language-popover`;
  const languagesQuery = useQuery({
    ...additionalLanguagesQueryOptions(
      queryScope,
      form.market?.marketId ?? "",
      form.market?.countryCode ?? "",
      endpoint,
    ),
    enabled:
      active && scopeReady && Boolean(form.market) && !form.pendingFeedId,
  });
  const selectableMarkets = useMemo(() => {
    if (
      !form.market ||
      marketOptions.some(({ value }) => value === form.market?.value)
    ) {
      return marketOptions;
    }
    return [form.market, ...marketOptions];
  }, [form.market, marketOptions]);
  const selectableLanguages = useMemo(() => {
    if (!form.market || !languagesQuery.data?.ok) {
      return form.language ? [form.language] : [];
    }

    const available = availableLanguagesForForm(
      languagesQuery.data.languages,
      form.market,
      forms,
      form.id,
    );
    if (
      form.language &&
      !available.some(
        ({ locale }) =>
          locale.toLocaleLowerCase() ===
          form.language?.locale.toLocaleLowerCase(),
      )
    ) {
      return [form.language, ...available];
    }
    return available;
  }, [form.id, form.language, form.market, forms, languagesQuery.data]);
  const selectionLocked = isGenerating || Boolean(form.pendingFeedId);
  const normalizedMarketSearch = marketSearch
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  const normalizedLanguageSearch = languageSearch
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  const filteredMarkets = selectableMarkets.filter((option) =>
    [
      option.marketName,
      option.countryName,
      option.countryCode,
      option.currencyCode,
    ]
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .includes(normalizedMarketSearch),
  );
  const filteredLanguages = selectableLanguages.filter((language) =>
    [language.name, language.locale]
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .includes(normalizedLanguageSearch),
  );
  const marketDisabled = marketLoading || marketError || selectionLocked;
  const languageDisabled =
    !form.market ||
    languagesQuery.isPending ||
    languagesQuery.isError ||
    selectionLocked;

  return (
    <div className={styles.addMarketForm}>
      <div className={styles.selectorGrid}>
        <div className={styles.selectorField}>
          <span className={styles.selectorLabelWithLoading}>
            <span className={styles.selectorLabel}>Market and country</span>
            {marketLoading ||
            (form.market &&
              languagesQuery.isPending &&
              !form.pendingFeedId) ? (
              <s-spinner
                accessibilityLabel="Loading Shopify Market options"
                size="base"
              />
            ) : null}
          </span>
          <s-clickable
            accessibilityLabel="Choose a Shopify Market and country"
            background="base"
            border="small-100"
            borderColor="base"
            borderRadius="base"
            borderStyle="solid"
            commandFor={marketPopoverId}
            disabled={marketDisabled ? true : undefined}
            inlineSize="100%"
            padding="small-200 base"
          >
            <s-stack
              alignItems="center"
              direction="inline"
              gap="small"
              justifyContent="space-between"
            >
              <s-text color={form.market ? "base" : "subdued"}>
                {form.market
                  ? `${form.market.marketName}: ${form.market.countryName} / ${form.market.currencyCode}`
                  : marketLoading
                    ? "Loading Shopify Markets"
                    : "Choose market and country"}
              </s-text>
              <s-icon color="subdued" type="chevron-down" />
            </s-stack>
          </s-clickable>
          {form.error === "Choose a market and country." ? (
            <span className={styles.formError} role="alert">
              {form.error}
            </span>
          ) : null}
          <s-popover
            id={marketPopoverId}
            inlineSize="420px"
            onHide={hydrated ? () => setMarketSearch("") : undefined}
            onShow={
              hydrated
                ? () => {
                    window.requestAnimationFrame(() =>
                      marketSearchRef.current?.focus(),
                    );
                  }
                : undefined
            }
          >
            <s-box padding="small-200">
              <div className={styles.selectorPopoverContent}>
                <s-search-field
                  label="Search Markets and countries"
                  labelAccessibilityVisibility="exclusive"
                  onInput={(event) =>
                    setMarketSearch(event.currentTarget.value)
                  }
                  placeholder="Search market or country"
                  ref={marketSearchRef}
                  value={marketSearch}
                />
                <div className={styles.selectorResults}>
                  {filteredMarkets.length === 0 ? (
                    <div className={styles.selectorEmpty}>
                      <s-text color="subdued">
                        No Markets or countries found.
                      </s-text>
                    </div>
                  ) : (
                    <s-stack direction="block" gap="small-100">
                      {filteredMarkets.map((option) => (
                        <s-button
                          command="--hide"
                          commandFor={marketPopoverId}
                          key={option.value}
                          onClick={() => {
                            setMarketSearch("");
                            setLanguageSearch("");
                            onUpdate(form.id, {
                              error: null,
                              language: null,
                              market: option,
                              pendingFeedId: null,
                            });
                          }}
                          variant="tertiary"
                        >
                          {option.marketName}: {option.countryName} /{" "}
                          {option.currencyCode}
                        </s-button>
                      ))}
                    </s-stack>
                  )}
                </div>
              </div>
            </s-box>
          </s-popover>
        </div>

        <div className={styles.selectorField}>
          <span className={styles.selectorLabel}>Language</span>
          <s-clickable
            accessibilityLabel="Choose a feed language"
            background="base"
            border="small-100"
            borderColor="base"
            borderRadius="base"
            borderStyle="solid"
            commandFor={languagePopoverId}
            disabled={languageDisabled ? true : undefined}
            inlineSize="100%"
            padding="small-200 base"
          >
            <s-stack
              alignItems="center"
              direction="inline"
              gap="small"
              justifyContent="space-between"
            >
              <s-text color={form.language ? "base" : "subdued"}>
                {form.language
                  ? `${form.language.name} / ${form.language.locale.toUpperCase()}`
                  : languagesQuery.isPending
                    ? "Loading languages"
                    : "Choose language"}
              </s-text>
              <s-icon color="subdued" type="chevron-down" />
            </s-stack>
          </s-clickable>
          {form.error === "Choose a language." ? (
            <span className={styles.formError} role="alert">
              {form.error}
            </span>
          ) : null}
          <s-popover
            id={languagePopoverId}
            inlineSize="420px"
            onHide={hydrated ? () => setLanguageSearch("") : undefined}
            onShow={
              hydrated
                ? () => {
                    window.requestAnimationFrame(() =>
                      languageSearchRef.current?.focus(),
                    );
                  }
                : undefined
            }
          >
            <s-box padding="small-200">
              <div className={styles.selectorPopoverContent}>
                <s-search-field
                  label="Search feed languages"
                  labelAccessibilityVisibility="exclusive"
                  onInput={(event) =>
                    setLanguageSearch(event.currentTarget.value)
                  }
                  placeholder="Search language"
                  ref={languageSearchRef}
                  value={languageSearch}
                />
                <div className={styles.selectorResults}>
                  {filteredLanguages.length === 0 ? (
                    <div className={styles.selectorEmpty}>
                      <s-text color="subdued">No languages found.</s-text>
                    </div>
                  ) : (
                    <s-stack direction="block" gap="small-100">
                      {filteredLanguages.map((language) => (
                        <s-button
                          command="--hide"
                          commandFor={languagePopoverId}
                          key={language.locale}
                          onClick={() => {
                            setLanguageSearch("");
                            onUpdate(form.id, {
                              error: null,
                              language,
                            });
                          }}
                          variant="tertiary"
                        >
                          {language.name} / {language.locale.toUpperCase()}
                        </s-button>
                      ))}
                    </s-stack>
                  )}
                </div>
              </div>
            </s-box>
          </s-popover>
        </div>
      </div>

      {languagesQuery.isError && !form.pendingFeedId ? (
        <div className={styles.inlineError}>
          <span className={styles.formError} role="alert">
            Languages could not be loaded for this Market and country.
          </span>
          <s-button
            onClick={() => void languagesQuery.refetch()}
            variant="secondary"
          >
            Retry
          </s-button>
        </div>
      ) : null}

      {form.market &&
      languagesQuery.data?.ok &&
      selectableLanguages.length === 0 &&
      !form.pendingFeedId ? (
        <s-text color="subdued">
          No ungenerated languages remain for this Market and country.
        </s-text>
      ) : null}

      {form.error &&
      !["Choose a market and country.", "Choose a language."].includes(
        form.error,
      ) ? (
        <span className={styles.formError} role="alert">
          {form.error}
        </span>
      ) : null}

      {isGenerating && form.market && form.language ? (
        <s-text color="subdued">
          Generating {form.market.marketName} / {form.market.countryName} /{" "}
          {form.language.name}
          {progress ? ` (${progress})` : ""}
        </s-text>
      ) : null}

      <div className={styles.formActions}>
        <s-button
          disabled={generationLocked ? true : undefined}
          loading={isGenerating ? true : undefined}
          onClick={() => onGenerate(form)}
          variant="primary"
        >
          {form.pendingFeedId && form.error
            ? "Retry generation"
            : "Generate feed URL"}
        </s-button>
        <s-button
          disabled={isGenerating ? true : undefined}
          onClick={() => onRemove(form.id)}
          variant="secondary"
        >
          Cancel
        </s-button>
      </div>
    </div>
  );
}

export function FeedsPanel({ active, scope }: FeedsPanelProps) {
  const hydrated = useHydrated();
  const shopify = useAppBridge();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{
    message: string;
    tone: "critical";
  } | null>(null);
  const [additionalForms, setAdditionalForms] = useState<
    AdditionalMarketFormState[]
  >([]);
  const nextFormId = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<AdditionalFeedEntry | null>(
    null,
  );
  const [automaticWorkActive, setAutomaticWorkActive] = useState(false);
  const [automaticRefreshAlerts, setAutomaticRefreshAlerts] = useState<
    TabAlert[]
  >([]);
  const [refreshAllRunId, setRefreshAllRunId] = useState<string | null>(null);
  const wasActive = useRef(false);
  const previousFeedRefreshRequired = useRef<boolean | null>(null);
  const endpoint = "/app/feed-data";
  const additionalEndpoint = "/app/additional-feeds";
  const queryScope = scope ?? {
    locale: null,
    sessionId: "pending",
    shop: "pending",
  };
  const synchronizeConfigurationRefreshState = useCallback(
    async (feedsAreFresh = false) => {
      if (!scope) return;

      const queryKey = configurationKeys.configuration(scope);
      if (feedsAreFresh) {
        queryClient.setQueryData<ConfigurationResponse>(queryKey, (current) =>
          current
            ? {
                ...current,
                feedRefreshRequired: false,
              }
            : current,
        );
        return;
      }

      try {
        await queryClient.fetchQuery({
          ...configurationQueryOptions(scope),
          staleTime: 0,
        });
      } catch {
        await queryClient.invalidateQueries({
          queryKey,
          refetchType: "none",
        });
      }
    },
    [queryClient, scope],
  );
  const query = useQuery({
    ...primaryFeedQueryOptions(queryScope, endpoint),
    enabled: active && Boolean(scope),
    refetchInterval: (currentQuery) =>
      active && shouldPollPrimaryFeed(currentQuery.state.data) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const additionalQuery = useQuery({
    ...additionalFeedsQueryOptions(queryScope, additionalEndpoint),
    enabled: active && Boolean(scope),
    refetchInterval: (currentQuery) =>
      active && hasPendingAdditionalFeeds(currentQuery.state.data)
        ? 2_000
        : false,
    refetchIntervalInBackground: false,
  });
  const refreshAllStatusQuery = useQuery({
    ...refreshAllStatusQueryOptions(
      queryScope,
      refreshAllRunId ?? "pending",
    ),
    enabled: active && Boolean(scope) && Boolean(refreshAllRunId),
    refetchInterval: (currentQuery) => {
      const status = currentQuery.state.data?.status;
      return status === "SUCCESS" ||
        status === "PARTIALLY_FAILED" ||
        status === "FAILED"
        ? false
        : 2_000;
    },
    refetchIntervalInBackground: false,
  });
  const refetchAdditionalFeeds = additionalQuery.refetch;
  const marketOptionsQuery = useQuery({
    ...additionalMarketOptionsQueryOptions(queryScope, additionalEndpoint),
    enabled: active && Boolean(scope) && additionalForms.length > 0,
  });
  const invalidateFeedQueries = async () => {
    if (!scope) return;
    await queryClient.invalidateQueries({
      queryKey: feedKeys.all(scope),
    });
  };
  const applyAdditionalActionResult = (
    result: AdditionalFeedActionResponse,
  ) => {
    if (!scope || !result.ok) return;
    queryClient.setQueryData<AdditionalFeedsResponse>(
      feedKeys.additional(scope, additionalEndpoint),
      (current) => {
        if (!current?.ok || !result.entry) return current;
        const feeds = current.feeds.some(
          ({ feed }) => feed.id === result.entry?.feed.id,
        )
          ? current.feeds.map((entry) =>
              entry.feed.id === result.entry?.feed.id ? result.entry! : entry,
            )
          : [...current.feeds, result.entry];

        return {
          ...current,
          activeGeneration: result.activeGeneration ?? current.activeGeneration,
          feeds,
        };
      },
    );
  };
  const mutation = useMutation({
    mutationFn: () => generatePrimaryFeed(endpoint),
    onSuccess: (data) => {
      if (scope) {
        queryClient.setQueryData(feedKeys.primary(scope, endpoint), data);
        void queryClient.invalidateQueries({
          queryKey: feedKeys.additional(scope, additionalEndpoint),
        });
      }
      setFeedback(null);
    },
    onError: (error) => {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "Feed generation couldn't be started. Try again.",
        tone: "critical",
      });
    },
  });
  const additionalGenerateMutation = useMutation({
    mutationFn: (request: {
      countryCode: string;
      formId: string;
      locale: string;
      marketId: string;
      retryFeedId: string | null;
    }) =>
      request.retryFeedId
        ? refreshAdditionalFeed(request.retryFeedId, additionalEndpoint)
        : generateAdditionalFeed(
            {
              countryCode: request.countryCode,
              locale: request.locale,
              marketId: request.marketId,
            },
            additionalEndpoint,
          ),
    onSuccess: (result, request) => {
      applyAdditionalActionResult(result);
      const pendingFeedId =
        (result.ok ? result.entry?.feed.id : null) ?? request.retryFeedId;
      setAdditionalForms((forms) =>
        forms.map((form) =>
          form.id === request.formId
            ? { ...form, error: null, pendingFeedId }
            : form,
        ),
      );
      setFeedback(null);
      void invalidateFeedQueries();
      shopify.toast.show("Additional Market feed generation started.");
    },
    onError: (error, request) => {
      setAdditionalForms((forms) =>
        forms.map((form) =>
          form.id === request.formId
            ? {
                ...form,
                error:
                  error instanceof Error
                    ? error.message
                    : "The additional feed couldn't be generated.",
              }
            : form,
        ),
      );
      void invalidateFeedQueries();
    },
  });
  const additionalRefreshMutation = useMutation({
    mutationFn: (feedId: string) =>
      refreshAdditionalFeed(feedId, additionalEndpoint),
    onSuccess: (result) => {
      applyAdditionalActionResult(result);
      setFeedback(null);
      void invalidateFeedQueries();
      shopify.toast.show("Feed refresh started.");
    },
    onError: (error) => {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "The feed refresh couldn't be started.",
        tone: "critical",
      });
    },
  });
  const refreshAllMutation = useMutation({
    mutationFn: () => refreshAllFeeds(),
    onSuccess: (result) => {
      setFeedback(null);
      setRefreshAllRunId(result.runId);
      if (scope) {
        queryClient.setQueryData<FeedDataResponse>(
          feedKeys.primary(scope, endpoint),
          (current) =>
            current?.ok
              ? {
                  ...current,
                  activeGeneration: result.activeGeneration,
                }
              : current,
        );
        queryClient.setQueryData<AdditionalFeedsResponse>(
          feedKeys.additional(scope, additionalEndpoint),
          (current) =>
            current?.ok
              ? {
                  ...current,
                  activeGeneration: result.activeGeneration,
                }
              : current,
        );
      }
      void invalidateFeedQueries();
      shopify.toast.show(
        `Refreshing ${result.totalFeeds} XML ${
          result.totalFeeds === 1 ? "feed" : "feeds"
        }.`,
      );
    },
    onError: (error) => {
      setRefreshAllRunId(null);
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "The XML refresh couldn't be started.",
        tone: "critical",
      });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (feedId: string) =>
      deleteAdditionalFeed(feedId, additionalEndpoint),
    onSuccess: () => {
      setFeedback(null);
      setDeleteTarget(null);
      void invalidateFeedQueries();
      shopify.toast.show("Additional Market feed deleted.");
    },
    onError: (error) => {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "The additional feed couldn't be deleted.",
        tone: "critical",
      });
    },
  });
  const queryData = query.data;
  const refetchFeed = query.refetch;

  useEffect(() => {
    if (active && !wasActive.current) {
      if (queryData) void refetchFeed();
      if (additionalQuery.data) void refetchAdditionalFeeds();
    }
    wasActive.current = active;
  }, [
    active,
    additionalQuery.data,
    queryData,
    refetchAdditionalFeeds,
    refetchFeed,
  ]);

  const data = isSuccessfulFeedData(queryData) ? queryData : null;
  const feed = data?.feed ?? null;
  const market = data?.market ?? null;
  const additionalData =
    additionalQuery.data && additionalQuery.data.ok === true
      ? additionalQuery.data
      : null;
  const additionalFeeds = useMemo(
    () => additionalData?.feeds ?? [],
    [additionalData],
  );
  const feedRefreshRequired = Boolean(
    feed?.requiresRefresh ||
      additionalFeeds.some(({ feed: candidate }) => candidate.requiresRefresh),
  );
  useEffect(() => {
    const previous = previousFeedRefreshRequired.current;
    previousFeedRefreshRequired.current = feedRefreshRequired;
    if (previous === true && !feedRefreshRequired) {
      void synchronizeConfigurationRefreshState(true);
    }
  }, [feedRefreshRequired, synchronizeConfigurationRefreshState]);
  const visibleAdditionalFeeds = useMemo(
    () => visibleAdditionalFeedEntries(additionalFeeds, additionalForms),
    [additionalFeeds, additionalForms],
  );
  const backendUnavailable = Boolean(data?.backendUnavailable);
  const primaryGenerationInProgress = Boolean(
    feed && pendingStatuses.has(feed.status),
  );
  const generationInProgress = Boolean(
    primaryGenerationInProgress ||
    data?.activeGeneration ||
    additionalData?.activeGeneration ||
    additionalFeeds.some(({ feed: candidate }) =>
      pendingStatuses.has(candidate.status),
    ),
  );
  const generationLocked =
    automaticWorkActive ||
    Boolean(refreshAllRunId) ||
    generationInProgress ||
    mutation.isPending ||
    additionalGenerateMutation.isPending ||
    additionalRefreshMutation.isPending ||
    refreshAllMutation.isPending;
  const activeGeneration =
    additionalData?.activeGeneration ?? data?.activeGeneration ?? null;
  const successfulFeed = Boolean(feed?.gcsObjectName && feed.lastRefreshedAt);
  const hasRefreshableFeeds =
    successfulFeed ||
    additionalFeeds.some(
      ({ feed: candidate }) =>
        Boolean(candidate.gcsObjectName && candidate.lastRefreshedAt),
    );
  const progress = feed ? generationProgress(feed) : null;

  useEffect(() => {
    setAdditionalForms((forms) =>
      reconcileAdditionalMarketForms(forms, additionalFeeds),
    );
  }, [additionalFeeds]);

  useEffect(() => {
    const result = refreshAllStatusQuery.data;
    if (
      !refreshAllRunId ||
      !result ||
      (result.status !== "SUCCESS" &&
        result.status !== "PARTIALLY_FAILED" &&
        result.status !== "FAILED")
    ) {
      return;
    }

    setRefreshAllRunId(null);
    void Promise.all([
      refetchFeed(),
      refetchAdditionalFeeds(),
      synchronizeConfigurationRefreshState(result.status === "SUCCESS"),
    ]);

    if (result.status === "SUCCESS") {
      shopify.toast.show(
        `All ${result.completedFeeds} XML ${
          result.completedFeeds === 1 ? "feed was" : "feeds were"
        } refreshed.`,
      );
      return;
    }

    setFeedback({
      message:
        result.runError ??
        `${result.failedFeeds} XML ${
          result.failedFeeds === 1 ? "feed" : "feeds"
        } could not be refreshed.`,
      tone: "critical",
    });
  }, [
    refreshAllRunId,
    refreshAllStatusQuery.data,
    synchronizeConfigurationRefreshState,
    refetchAdditionalFeeds,
    refetchFeed,
    shopify,
  ]);

  const generate = async () => {
    if (!market || generationLocked || mutation.isPending) {
      return;
    }

    if (backendUnavailable) {
      const refreshed = await query.refetch();
      if (!refreshed.data?.ok || refreshed.data.backendUnavailable) {
        shopify.toast.show(
          "The feed service is unavailable. Please try again later.",
          { isError: true },
        );
        return;
      }
    }

    setFeedback(null);
    mutation.mutate();
  };

  const openFeed = () => {
    if (!feed?.publicUrl) return;
    const opened = window.open(feed.publicUrl, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  };

  const copyFeed = async () => {
    if (!feed?.publicUrl) return;

    try {
      await navigator.clipboard.writeText(feed.publicUrl);
      setFeedback(null);
      shopify.toast.show("Feed URL copied to the clipboard.");
    } catch {
      setFeedback({
        message:
          "The Feed URL couldn't be copied. Select and copy it manually.",
        tone: "critical",
      });
    }
  };

  const copyAdditionalFeed = async (entry: AdditionalFeedEntry) => {
    try {
      await navigator.clipboard.writeText(entry.feed.publicUrl);
      setFeedback(null);
      shopify.toast.show("Feed URL copied to the clipboard.");
    } catch {
      setFeedback({
        message:
          "The Feed URL couldn't be copied. Select and copy it manually.",
        tone: "critical",
      });
    }
  };

  const updateAdditionalForm = (
    formId: string,
    update: Partial<AdditionalMarketFormState>,
  ) => {
    setAdditionalForms((forms) =>
      reconcileAdditionalMarketForms(
        forms.map((form) =>
          form.id === formId ? { ...form, ...update } : form,
        ),
        additionalFeeds,
      ),
    );
  };

  const generateAdditional = (form: AdditionalMarketFormState) => {
    if (!form.market) {
      updateAdditionalForm(form.id, {
        error: "Choose a market and country.",
      });
      return;
    }
    if (!form.language) {
      updateAdditionalForm(form.id, {
        error: "Choose a language.",
      });
      return;
    }
    if (
      selectedAdditionalFormCombinations(additionalForms, form.id).has(
        additionalFormCombinationKey(form.market, form.language),
      )
    ) {
      updateAdditionalForm(form.id, {
        error:
          "Another open form already uses this Market, country, and language.",
      });
      return;
    }
    if (generationLocked) {
      updateAdditionalForm(form.id, {
        error: "Wait for the current XML feed generation to finish.",
      });
      return;
    }

    updateAdditionalForm(form.id, { error: null });
    additionalGenerateMutation.mutate({
      countryCode: form.market.countryCode,
      formId: form.id,
      locale: form.language.locale,
      marketId: form.market.marketId,
      retryFeedId: form.pendingFeedId,
    });
  };

  const tabAlerts: TabAlert[] = [];
  if (feedback) {
    tabAlerts.push({
      heading: feedback.message,
      id: "feed-feedback",
      tone: feedback.tone,
    });
  }
  if (refreshAllRunId && refreshAllStatusQuery.isError) {
    tabAlerts.push({
      actionLabel: "Retry",
      actionLoading: refreshAllStatusQuery.isFetching,
      heading: "XML refresh status couldn't be loaded",
      id: "refresh-all-status",
      message:
        refreshAllStatusQuery.error instanceof Error
          ? refreshAllStatusQuery.error.message
          : "Try loading the refresh status again.",
      onAction: () => void refreshAllStatusQuery.refetch(),
      tone: "critical",
    });
  }
  if (query.isError) {
    tabAlerts.push({
      actionLabel: "Try again",
      actionLoading: query.isFetching,
      heading: "Feeds couldn't be loaded",
      id: "primary-feed-load",
      message:
        query.error instanceof Error
          ? query.error.message
          : "The feed service is unavailable.",
      onAction: () => void query.refetch(),
      tone: "critical",
    });
  }
  if (additionalQuery.isError) {
    tabAlerts.push({
      actionLabel: "Try again",
      actionLoading: additionalQuery.isFetching,
      heading: "Additional Market feeds couldn't be loaded",
      id: "additional-feeds-load",
      message:
        additionalQuery.error instanceof Error
          ? additionalQuery.error.message
          : "The feed service is unavailable.",
      onAction: () => void additionalQuery.refetch(),
      tone: "critical",
    });
  }
  if (data?.marketUnavailable && !backendUnavailable) {
    tabAlerts.push({
      heading: "Shopify Market details may be outdated",
      id: "market-details-warning",
      message:
        "The saved Primary Feed is still available, but Shopify didn't return current market details.",
      tone: "warning",
    });
  }
  if (feed?.status === "FAILED" && feed.lastError) {
    tabAlerts.push({
      heading: "Feed generation failed",
      id: "primary-feed-generation",
      message: feed.lastError,
      tone: "critical",
    });
  }
  tabAlerts.push(...automaticRefreshAlerts);

  return (
    <div className={styles.feeds}>
      <div className={styles.header}>
        <div>
          <s-heading>Feeds</s-heading>
          <s-paragraph color="subdued">
            Manage your primary Google feed and additional Shopify Markets
            feeds.
          </s-paragraph>
        </div>
        <s-button
          accessibilityLabel="Refresh all XML feeds"
          disabled={
            !scope ||
            !hasRefreshableFeeds ||
            backendUnavailable ||
            additionalData?.backendUnavailable ||
            generationLocked
              ? true
              : undefined
          }
          icon="refresh"
          loading={
            refreshAllMutation.isPending || Boolean(refreshAllRunId)
              ? true
              : undefined
          }
          onClick={() => refreshAllMutation.mutate()}
          variant="primary"
        >
          Refresh all XMLs
        </s-button>
      </div>

      <TabAlertNavigator alerts={tabAlerts} />

      <s-section>
        <div className={styles.feedTable}>
          <s-table>
            <s-table-header-row>
              <s-table-header format="base" listSlot="primary">
                <span className={styles.tableHeader}>Feed</span>
              </s-table-header>
              <s-table-header format="base" listSlot="labeled">
                <span className={styles.tableHeader}>Market</span>
              </s-table-header>
              <s-table-header format="base" listSlot="labeled">
                <span className={styles.tableHeader}>Feed URL</span>
              </s-table-header>
              <s-table-header format="base" listSlot="labeled">
                <span className={styles.tableHeader}>Last refresh</span>
              </s-table-header>
              <s-table-header format="base" listSlot="inline">
                <span className={styles.tableHeader}>Actions</span>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {query.isPending && !data ? (
                <LoadingRow />
              ) : (
                <s-table-row>
                  <s-table-cell>
                    <span
                      className={`${styles.primaryLabel} ${styles.feedName}`}
                    >
                      Primary feed
                    </span>
                    {feed ? (
                      <span className={styles.statusStack}>
                        <FeedStatusBadge
                          requiresRefresh={feed.requiresRefresh}
                          status={feed.status}
                        />
                        {progress ? (
                          <span className={styles.progressText}>
                            {progress}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>
                    {market ? (
                      <>
                        <span className={styles.primaryLabel}>
                          {market.name}
                        </span>
                        <span className={styles.marketDetails}>
                          {[
                            market.countryName ?? market.countryCode,
                            market.currencyCode,
                            market.locale.toLocaleUpperCase(),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </>
                    ) : (
                      <span className={styles.secondaryText}>Unavailable</span>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {successfulFeed && feed ? (
                      <>
                        <a
                          className={styles.feedUrl}
                          href={feed.publicUrl}
                          rel="noreferrer"
                          target="_blank"
                          title={feed.publicUrl}
                        >
                          {feed.publicUrl}
                        </a>
                        <FeedFileDetails feed={feed} />
                      </>
                    ) : (
                      <span className={styles.secondaryText}>
                        Available after generation
                      </span>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {feed?.lastRefreshedAt ? (
                      <>
                        <span className={styles.primaryLabel}>
                          {formatRefreshDate(
                            feed.lastRefreshedAt,
                            scope?.locale ?? null,
                          )}
                        </span>
                      </>
                    ) : (
                      <span className={styles.secondaryText}>
                        Never generated
                      </span>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <div className={styles.actions}>
                      {successfulFeed && feed ? (
                        <>
                          <s-button
                            accessibilityLabel="Open Primary Feed in a new tab"
                            icon="external"
                            interestFor="primary-feed-open-tooltip"
                            onClick={openFeed}
                            variant="secondary"
                          />
                          <s-tooltip id="primary-feed-open-tooltip">
                            Open
                          </s-tooltip>
                          <s-button
                            accessibilityLabel="Refresh Primary Feed"
                            disabled={
                              generationLocked ||
                              query.isFetching ||
                              mutation.isPending
                                ? true
                                : undefined
                            }
                            icon="refresh"
                            interestFor="primary-feed-refresh-tooltip"
                            loading={
                              primaryGenerationInProgress || mutation.isPending
                                ? true
                                : undefined
                            }
                            onClick={() => void generate()}
                            variant="secondary"
                          />
                          <s-tooltip id="primary-feed-refresh-tooltip">
                            Refresh XML
                          </s-tooltip>
                          <s-button
                            accessibilityLabel="Copy Primary Feed URL"
                            icon="clipboard"
                            interestFor="primary-feed-copy-tooltip"
                            onClick={() => void copyFeed()}
                            variant="secondary"
                          />
                          <s-tooltip id="primary-feed-copy-tooltip">
                            Copy
                          </s-tooltip>
                        </>
                      ) : primaryGenerationInProgress ? (
                        <s-button disabled loading variant="secondary">
                          Generating
                        </s-button>
                      ) : (
                        <s-button
                          disabled={
                            !market ||
                            generationLocked ||
                            query.isFetching ||
                            mutation.isPending
                              ? true
                              : undefined
                          }
                          loading={
                            query.isFetching || mutation.isPending
                              ? true
                              : undefined
                          }
                          onClick={() => void generate()}
                          variant="primary"
                        >
                          {feed?.status === "FAILED"
                            ? "Retry generation"
                            : "Generate XML feed"}
                        </s-button>
                      )}
                    </div>
                    <span aria-live="polite" className={styles.visuallyHidden}>
                      {primaryGenerationInProgress ? progress : ""}
                    </span>
                  </s-table-cell>
                </s-table-row>
              )}
            </s-table-body>
          </s-table>
        </div>
      </s-section>

      <s-section>
        <div className={styles.additionalHeader}>
          <div>
            <s-heading>Additional Market feeds</s-heading>
            <s-paragraph color="subdued">
              Create localized Google feeds for specific Shopify Markets,
              countries, currencies, and languages.
            </s-paragraph>
          </div>
          <s-button
            disabled={
              additionalData?.backendUnavailable || generationLocked
                ? true
                : undefined
            }
            onClick={() => {
              nextFormId.current += 1;
              setAdditionalForms((forms) => [
                ...forms,
                createAdditionalMarketForm(
                  `additional-market-${nextFormId.current}`,
                ),
              ]);
            }}
            variant="primary"
          >
            + Add Market
          </s-button>
        </div>

        {additionalQuery.isPending && !additionalData ? (
          <div className={styles.feedTable}>
            <s-table>
              <s-table-header-row>
                <s-table-header format="base" listSlot="primary">
                  <span className={styles.tableHeader}>Feed</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Market</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Feed URL</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Last refresh</span>
                </s-table-header>
                <s-table-header format="base" listSlot="inline">
                  <span className={styles.tableHeader}>Actions</span>
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                <LoadingRow />
              </s-table-body>
            </s-table>
          </div>
        ) : visibleAdditionalFeeds.length === 0 ? (
          <div className={styles.emptyState}>
            <s-heading>No additional market feeds</s-heading>
            <s-paragraph color="subdued">
              Create localized Google feeds for specific Shopify Markets,
              countries, currencies, and languages.
            </s-paragraph>
          </div>
        ) : (
          <div className={styles.feedTable}>
            <s-table>
              <s-table-header-row>
                <s-table-header format="base" listSlot="primary">
                  <span className={styles.tableHeader}>Feed</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Market</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Feed URL</span>
                </s-table-header>
                <s-table-header format="base" listSlot="labeled">
                  <span className={styles.tableHeader}>Last refresh</span>
                </s-table-header>
                <s-table-header format="base" listSlot="inline">
                  <span className={styles.tableHeader}>Actions</span>
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visibleAdditionalFeeds.map((entry) => {
                  const candidate = entry.feed;
                  const candidatePending = pendingStatuses.has(
                    candidate.status,
                  );
                  const candidateDeleting =
                    deleteMutation.isPending &&
                    deleteMutation.variables === candidate.id;
                  const candidateReady = Boolean(
                    candidate.gcsObjectName && candidate.lastRefreshedAt,
                  );
                  const candidateProgress = generationProgress(candidate);

                  return (
                    <s-table-row key={candidate.id}>
                      <s-table-cell>
                        <span
                          className={`${styles.primaryLabel} ${styles.feedName}`}
                        >
                          Additional feed
                        </span>
                        <span className={styles.statusStack}>
                          <FeedStatusBadge
                            requiresRefresh={candidate.requiresRefresh}
                            status={candidate.status}
                          />
                          {candidateProgress ? (
                            <span className={styles.progressText}>
                              {candidateProgress}
                            </span>
                          ) : null}
                          {candidate.status === "FAILED" &&
                          candidate.lastError ? (
                            <span className={styles.rowError}>
                              {candidate.lastError}
                            </span>
                          ) : null}
                        </span>
                      </s-table-cell>
                      <s-table-cell>
                        <span className={styles.primaryLabel}>
                          {entry.market.name}
                        </span>
                        <span className={styles.marketDetails}>
                          {[
                            entry.market.countryName ??
                              entry.market.countryCode,
                            entry.market.currencyCode,
                            entry.market.locale.toUpperCase(),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </s-table-cell>
                      <s-table-cell>
                        {candidateReady ? (
                          <>
                            <a
                              className={styles.feedUrl}
                              href={candidate.publicUrl}
                              rel="noreferrer"
                              target="_blank"
                              title={candidate.publicUrl}
                            >
                              {candidate.publicUrl}
                            </a>
                            <FeedFileDetails feed={candidate} />
                          </>
                        ) : (
                          <span className={styles.secondaryText}>
                            Available after generation
                          </span>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {candidate.lastRefreshedAt ? (
                          <>
                            <span className={styles.primaryLabel}>
                              {formatRefreshDate(
                                candidate.lastRefreshedAt,
                                scope?.locale ?? null,
                              )}
                            </span>
                          </>
                        ) : (
                          <span className={styles.secondaryText}>
                            Never generated
                          </span>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <div className={styles.actions}>
                          {candidateReady ? (
                            <>
                              <s-button
                                accessibilityLabel={`Open ${entry.market.name} ${entry.market.countryName ?? ""} ${entry.market.locale} feed in a new tab`}
                                icon="external"
                                interestFor={`additional-feed-${candidate.id}-open-tooltip`}
                                onClick={() => {
                                  const opened = window.open(
                                    candidate.publicUrl,
                                    "_blank",
                                    "noopener,noreferrer",
                                  );
                                  if (opened) opened.opener = null;
                                }}
                                variant="secondary"
                              />
                              <s-tooltip
                                id={`additional-feed-${candidate.id}-open-tooltip`}
                              >
                                Open
                              </s-tooltip>
                              <s-button
                                accessibilityLabel={`Refresh ${entry.market.name} ${entry.market.locale} feed`}
                                disabled={
                                  generationLocked ||
                                  additionalRefreshMutation.isPending
                                    ? true
                                    : undefined
                                }
                                icon="refresh"
                                interestFor={`additional-feed-${candidate.id}-refresh-tooltip`}
                                loading={
                                  candidatePending ||
                                  (additionalRefreshMutation.isPending &&
                                    additionalRefreshMutation.variables ===
                                      candidate.id)
                                    ? true
                                    : undefined
                                }
                                onClick={() =>
                                  additionalRefreshMutation.mutate(candidate.id)
                                }
                                variant="secondary"
                              />
                              <s-tooltip
                                id={`additional-feed-${candidate.id}-refresh-tooltip`}
                              >
                                Refresh XML
                              </s-tooltip>
                              <s-button
                                accessibilityLabel={`Copy ${entry.market.name} ${entry.market.locale} feed URL`}
                                icon="clipboard"
                                interestFor={`additional-feed-${candidate.id}-copy-tooltip`}
                                onClick={() => void copyAdditionalFeed(entry)}
                                variant="secondary"
                              />
                              <s-tooltip
                                id={`additional-feed-${candidate.id}-copy-tooltip`}
                              >
                                Copy
                              </s-tooltip>
                            </>
                          ) : candidatePending ? (
                            <s-button disabled loading variant="secondary">
                              Generating
                            </s-button>
                          ) : (
                            <s-button
                              disabled={
                                generationLocked ||
                                additionalRefreshMutation.isPending
                                  ? true
                                  : undefined
                              }
                              onClick={() =>
                                additionalRefreshMutation.mutate(candidate.id)
                              }
                              variant="primary"
                            >
                              Retry generation
                            </s-button>
                          )}
                          <s-button
                            accessibilityLabel={`Delete ${entry.market.name} ${entry.market.countryName ?? ""} ${entry.market.locale} feed`}
                            command="--show"
                            commandFor="delete-additional-feed-modal"
                            disabled={
                              generationLocked ||
                              candidatePending ||
                              (deleteMutation.isPending &&
                                !candidateDeleting)
                                ? true
                                : undefined
                            }
                            icon="delete"
                            loading={candidateDeleting ? true : undefined}
                            onClick={() => setDeleteTarget(entry)}
                            tone="critical"
                            variant="secondary"
                          />
                        </div>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </div>
        )}

        {additionalForms.length > 0 && marketOptionsQuery.isError ? (
          <div className={styles.inlineError}>
            <span className={styles.formError} role="alert">
              Shopify Markets could not be loaded.
            </span>
            <s-button
              onClick={() => void marketOptionsQuery.refetch()}
              variant="secondary"
            >
              Retry
            </s-button>
          </div>
        ) : null}

        {additionalForms.length > 0 &&
        marketOptionsQuery.data?.ok &&
        marketOptionsQuery.data.options.length === 0 ? (
          <s-text color="subdued">
            Every available Market, country, and language combination already
            has a feed.
          </s-text>
        ) : null}

        <div className={styles.additionalFormList}>
          {additionalForms.map((form) => {
            const pendingEntry = form.pendingFeedId
              ? additionalFeeds.find(
                  ({ feed: candidate }) => candidate.id === form.pendingFeedId,
                )
              : null;
            const isGenerating =
              (additionalGenerateMutation.isPending &&
                additionalGenerateMutation.variables?.formId === form.id) ||
              Boolean(
                pendingEntry && pendingStatuses.has(pendingEntry.feed.status),
              ) ||
              activeGeneration?.feedId === form.pendingFeedId;

            return (
              <AdditionalMarketForm
                active={active}
                endpoint={additionalEndpoint}
                form={form}
                forms={additionalForms}
                generationLocked={generationLocked}
                isGenerating={isGenerating}
                key={form.id}
                marketError={marketOptionsQuery.isError}
                marketLoading={marketOptionsQuery.isPending}
                marketOptions={
                  marketOptionsQuery.data?.ok
                    ? marketOptionsQuery.data.options
                    : []
                }
                progress={
                  pendingEntry
                    ? generationProgress(pendingEntry.feed)
                    : null
                }
                onGenerate={generateAdditional}
                onRemove={(formId) =>
                  setAdditionalForms((forms) =>
                    forms.filter(({ id }) => id !== formId),
                  )
                }
                onUpdate={updateAdditionalForm}
                queryScope={queryScope}
                scopeReady={Boolean(scope)}
              />
            );
          })}
        </div>
      </s-section>

      <AutomaticRefreshCard
        active={active}
        key={
          scope
            ? `${scope.shop}:${scope.sessionId}`
            : "pending-feed-refresh-schedule"
        }
        onActivityChange={setAutomaticWorkActive}
        onAlertsChange={setAutomaticRefreshAlerts}
        scope={scope}
      />

      <s-modal
        accessibilityLabel="Delete additional Market feed confirmation"
        heading="Delete additional Market feed?"
        id="delete-additional-feed-modal"
        onHide={hydrated ? () => setDeleteTarget(null) : undefined}
      >
        <s-paragraph>
          {deleteTarget
            ? `Delete ${deleteTarget.market.name} / ${deleteTarget.market.countryName ?? deleteTarget.market.countryCode} / ${deleteTarget.market.languageName ?? deleteTarget.market.locale.toUpperCase()}?`
            : "Delete this additional Market feed?"}
        </s-paragraph>
        <s-paragraph color="subdued">
          Its XML file will be removed from cloud storage and the public URL
          will stop working. This cannot be undone.
        </s-paragraph>
        <s-button
          command="--hide"
          commandFor="delete-additional-feed-modal"
          disabled={
            !deleteTarget || generationLocked || deleteMutation.isPending
              ? true
              : undefined
          }
          loading={deleteMutation.isPending ? true : undefined}
          onClick={() => {
            if (deleteTarget) {
              deleteMutation.mutate(deleteTarget.feed.id);
            }
          }}
          slot="primary-action"
          tone="critical"
          variant="primary"
        >
          Delete feed
        </s-button>
        <s-button
          command="--hide"
          commandFor="delete-additional-feed-modal"
          slot="secondary-actions"
          variant="secondary"
        >
          Cancel
        </s-button>
      </s-modal>
    </div>
  );
}
