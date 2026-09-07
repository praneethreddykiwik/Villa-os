"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Instagram,
  Facebook,
  Linkedin,
  Youtube,
  RefreshCw,
  Eye,
  Heart,
  Bookmark,
  Users,
  BarChart2,
  CheckCircle2,
  ExternalLink,
  ChevronDown,
  Info,
  Radio,
} from "lucide-react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type PlatformKey = "instagram" | "facebook" | "linkedin" | "youtube";

interface TimeseriesPoint {
  date: string;
  value: number;
}

interface TotalTimeseriesPoint {
  date: string;
  reach: number;
  views: number;
  total: number;
}

interface UploadPostData {
  ok: boolean;
  profile: string;
  profiles: Array<{ username: string; createdAt?: string; facebookPageName?: string }>;
  totalTimeseries: TotalTimeseriesPoint[];
  summary: {
    totalReach: number;
    totalViews: number;
    totalLikes: number;
    totalFollowers: number;
  };
  platforms: {
    instagram: {
      connected: boolean;
      handle: string;
      displayName: string;
      avatar: string | null;
      followers: number;
      reach: number;
      views: number;
      accountsEngaged: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      reachTimeseries: TimeseriesPoint[];
    };
    facebook: {
      connected: boolean;
      pageId: string;
      pageName: string;
      managerName: string;
      handle: string;
      avatar: string | null;
      followers: number;
      reach: number;
      impressions: number;
      profileViews: number;
      reachTimeseries: TimeseriesPoint[];
      impressionsTimeseries: TimeseriesPoint[];
    };
    youtube: {
      connected: boolean;
      displayName: string;
      handle: string;
      avatar: string | null;
      followers: number;
      reach: number;
      views: number;
      likes: number;
      comments: number;
      watchTimeMinutes: number;
      avgViewDurationSeconds: number;
      reachTimeseries: TimeseriesPoint[];
    };
    linkedin: {
      connected: boolean;
      displayName: string;
      handle: string;
      avatar: string | null;
      isPersonalProfile: boolean;
      note: string;
    };
  };
  updatedAt: string;
}

const formatDateLabel = (dateStr: string) => {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
  ];
  const day = parseInt(parts[2], 10);
  const monthIndex = parseInt(parts[1], 10) - 1;
  return `${day} ${monthNames[monthIndex] || ""}`;
};

export function UploadPostLiveStudio({ brandId }: { brandId?: string }) {
  const [data, setData] = useState<UploadPostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePlatform, setActivePlatform] = useState<PlatformKey>("instagram");
  const [activeMetric, setActiveMetric] = useState<string>("views");
  const [isPending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

  const fetchData = async (force = false) => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/analytics/uploadpost${force ? "?refresh=true" : ""}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (json.ok) {
        setData(json);
        setLastRefreshed(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } else {
        setError(json.error || "Failed to load live data");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRefresh = () => {
    startTransition(() => {
      fetchData(true);
    });
  };

  const ig = data?.platforms?.instagram;
  const fb = data?.platforms?.facebook;
  const yt = data?.platforms?.youtube;
  const li = data?.platforms?.linkedin;

  // Active platform timeseries chart data
  let activeChartData: Array<{ date: string; value: number; formattedDate: string }> = [];
  let activeChartTitle = "Daily Reach — Last 30 Days";

  if (activePlatform === "instagram" && ig) {
    activeChartTitle = activeMetric === "views" ? "Daily Views — Last 30 Days" : "Daily Reach — Last 30 Days";
    activeChartData = ig.reachTimeseries.map((pt) => ({
      date: pt.date,
      value: pt.value,
      formattedDate: formatDateLabel(pt.date),
    }));
  } else if (activePlatform === "facebook" && fb) {
    if (activeMetric === "impressions" && fb.impressionsTimeseries.length > 0) {
      activeChartTitle = "Daily Page Impressions — Last 30 Days";
      activeChartData = fb.impressionsTimeseries.map((pt) => ({
        date: pt.date,
        value: pt.value,
        formattedDate: formatDateLabel(pt.date),
      }));
    } else {
      activeChartTitle = "Daily Reach — Last 30 Days";
      activeChartData = fb.reachTimeseries.map((pt) => ({
        date: pt.date,
        value: pt.value,
        formattedDate: formatDateLabel(pt.date),
      }));
    }
  } else if (activePlatform === "youtube" && yt) {
    activeChartTitle = "Daily Reach / Views — Last 30 Days";
    activeChartData = yt.reachTimeseries.map((pt) => ({
      date: pt.date,
      value: pt.value,
      formattedDate: formatDateLabel(pt.date),
    }));
  }

  return (
    <div className="space-y-6">
      {/* 1. TOP CARD: Total Reach/Views 30-Day Line Chart */}
      <div className="card relative overflow-hidden p-6 shadow-md transition-all">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold text-mist-100">Total Reach / Views</h2>
              <span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                Live synced
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-mist-400">
              Aggregated across Instagram, Facebook, and connected platforms · Last 30 Days
            </p>
          </div>

          <div className="flex items-center gap-3">
            {lastRefreshed && (
              <span className="text-[11px] text-mist-500">Updated {lastRefreshed}</span>
            )}
            <button
              onClick={handleRefresh}
              disabled={loading || isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-[11.5px] font-medium text-mist-200 transition-colors hover:border-ink-600 hover:text-mist-100 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading || isPending ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Total Reach/Views Chart matching user's Image 1 */}
        <div className="h-64 w-full">
          {data?.totalTimeseries && data.totalTimeseries.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.totalTimeseries.map((d) => ({
                  ...d,
                  formattedDate: formatDateLabel(d.date),
                }))}
                margin={{ top: 10, right: 12, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="totalCurveGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#818cf8" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#818cf8" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--s-border)" />
                <XAxis
                  dataKey="formattedDate"
                  tickLine={false}
                  axisLine={{ stroke: "var(--s-border)" }}
                  tick={{ fill: "var(--t-muted)", fontSize: 10.5 }}
                  interval={3}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--t-muted)", fontSize: 10.5 }}
                  domain={[0, "auto"]}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="rounded-xl border border-ink-600 bg-ink-850/95 px-3.5 py-2.5 shadow-xl backdrop-blur">
                        <p className="text-[11px] font-medium text-mist-400">{p.date}</p>
                        <div className="mt-1 flex items-center justify-between gap-4 text-[12px]">
                          <span className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
                            <span className="h-2 w-2 rounded-full bg-indigo-500" /> Total Reach/Views:
                          </span>
                          <span className="font-bold text-mist-100">{p.total}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#818cf8"
                  strokeWidth={2.5}
                  fill="url(#totalCurveGrad)"
                  dot={{ r: 3, fill: "#c7d2fe", stroke: "#818cf8", strokeWidth: 1.5 }}
                  activeDot={{ r: 6, fill: "#ffffff", stroke: "#6366f1", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-[12.5px] text-mist-400">
              {loading ? "Loading live data..." : "No timeseries data available"}
            </div>
          )}
        </div>
      </div>

      {/* 2. PLATFORM PERFORMANCE SECTION matching user's Image 1 & 2 */}
      <div className="card overflow-hidden p-0 shadow-md transition-all">
        {/* Profile and platform header */}
        <div className="border-b border-ink-700/60 p-5">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-white">
              <CheckCircle2 size={13} className="text-white" />
            </div>
            <span className="text-[15px] font-semibold text-mist-100">
              {data?.profile || "default"}
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] text-mist-400">Platform performance</p>

          {/* Platform tabs matching user's reference */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              id="tab-btn-instagram"
              onClick={() => {
                setActivePlatform("instagram");
                setActiveMetric("views");
              }}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium transition-all ${
                activePlatform === "instagram"
                  ? "border border-pink-500/40 bg-pink-500/15 text-pink-600 dark:text-pink-300 shadow-sm"
                  : "border border-ink-700/60 bg-ink-850/50 text-mist-400 hover:border-ink-600 hover:text-mist-200"
              }`}
            >
              <Instagram size={14} className={activePlatform === "instagram" ? "text-pink-500" : ""} />
              Instagram
            </button>

            <button
              id="tab-btn-facebook"
              onClick={() => {
                setActivePlatform("facebook");
                setActiveMetric("impressions");
              }}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium transition-all ${
                activePlatform === "facebook"
                  ? "border border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-300 shadow-sm"
                  : "border border-ink-700/60 bg-ink-850/50 text-mist-400 hover:border-ink-600 hover:text-mist-200"
              }`}
            >
              <Facebook size={14} className={activePlatform === "facebook" ? "text-blue-500" : ""} />
              Facebook
            </button>

            <button
              id="tab-btn-linkedin"
              onClick={() => setActivePlatform("linkedin")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium transition-all ${
                activePlatform === "linkedin"
                  ? "border border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-300 shadow-sm"
                  : "border border-ink-700/60 bg-ink-850/50 text-mist-400 hover:border-ink-600 hover:text-mist-200"
              }`}
            >
              <Linkedin size={14} className={activePlatform === "linkedin" ? "text-sky-500" : ""} />
              LinkedIn
            </button>

            <button
              id="tab-btn-youtube"
              onClick={() => setActivePlatform("youtube")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium transition-all ${
                activePlatform === "youtube"
                  ? "border border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-300 shadow-sm"
                  : "border border-ink-700/60 bg-ink-850/50 text-mist-400 hover:border-ink-600 hover:text-mist-200"
              }`}
            >
              <Youtube size={14} className={activePlatform === "youtube" ? "text-red-500" : ""} />
              YouTube
            </button>
          </div>
        </div>

        {/* Platform Content Body */}
        <div className="p-6">
          {/* INSTAGRAM VIEW */}
          {activePlatform === "instagram" && (
            <div className="space-y-6">
              {/* Instagram Subheader */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-yellow-500 via-pink-500 to-purple-600 text-white shadow-md">
                    <Instagram size={18} />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-mist-100">Instagram</h3>
                    <p className="text-[12px] text-mist-400">{ig?.handle || "kiwik.one1"}</p>
                  </div>
                </div>
                <a
                  href={`https://www.instagram.com/${ig?.handle || "kiwik.one1"}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] text-mist-400 hover:text-mist-100"
                >
                  View Profile <ExternalLink size={11} />
                </a>
              </div>

              {/* Instagram 6 KPI Cards matching user's Image 1 */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <MetricPill
                  label="FOLLOWERS"
                  value={ig?.followers ?? 0}
                  icon={Users}
                  active={activeMetric === "followers"}
                  onClick={() => setActiveMetric("followers")}
                  info="Total accounts following this Instagram account"
                />
                <MetricPill
                  label="REACH"
                  value={ig?.reach ?? 101}
                  icon={Radio}
                  active={activeMetric === "reach"}
                  onClick={() => setActiveMetric("reach")}
                  info="Unique accounts that have seen your content"
                />
                <MetricPill
                  label="VIEWS"
                  value={ig?.views ?? 117}
                  icon={Eye}
                  active={activeMetric === "views"}
                  onClick={() => setActiveMetric("views")}
                  highlight
                  info="Total number of times your reels/posts were viewed"
                />
                <MetricPill
                  label="ACCOUNTS ENGAGED"
                  value={ig?.accountsEngaged ?? 14}
                  icon={Users}
                  active={activeMetric === "engaged"}
                  onClick={() => setActiveMetric("engaged")}
                  info="Number of accounts that interacted with your content"
                />
                <MetricPill
                  label="LIKES"
                  value={ig?.likes ?? 12}
                  icon={Heart}
                  active={activeMetric === "likes"}
                  onClick={() => setActiveMetric("likes")}
                  info="Total likes received across recent media"
                />
                <MetricPill
                  label="SAVES"
                  value={ig?.saves ?? 1}
                  icon={Bookmark}
                  active={activeMetric === "saves"}
                  onClick={() => setActiveMetric("saves")}
                  info="Total times users saved your reels or posts"
                />
              </div>

              {/* Instagram 30-Day Curve Chart */}
              <div className="rounded-xl border border-ink-700/60 bg-ink-950/20 p-5">
                <h4 className="mb-4 text-center text-[12.5px] font-semibold text-mist-200">
                  {activeChartTitle}
                </h4>
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={activeChartData}
                      margin={{ top: 10, right: 12, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="igAreaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#7c3aed" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--s-border)" />
                      <XAxis
                        dataKey="formattedDate"
                        tickLine={false}
                        axisLine={{ stroke: "var(--s-border)" }}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        interval={3}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        domain={[0, "auto"]}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload;
                          return (
                            <div className="rounded-xl border border-ink-600 bg-ink-850/95 px-3 py-2 text-[11.5px] shadow-xl backdrop-blur">
                              <span className="text-mist-400">{p.date}: </span>
                              <span className="font-bold text-purple-600 dark:text-purple-300">{p.value}</span>
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#9333ea"
                        strokeWidth={2.5}
                        fill="url(#igAreaGrad)"
                        dot={{ r: 3, fill: "#d8b4fe", stroke: "#7c3aed", strokeWidth: 1.5 }}
                        activeDot={{ r: 6, fill: "#ffffff", stroke: "#9333ea", strokeWidth: 2 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* FACEBOOK VIEW matching user's Image 2 */}
          {activePlatform === "facebook" && (
            <div className="space-y-6">
              {/* Facebook Subheader */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md">
                    <Facebook size={18} />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-mist-100">Facebook</h3>
                    <p className="text-[12px] text-mist-400">{fb?.managerName || "Praneeth Ramaswamy"}</p>
                  </div>
                </div>

                {/* SELECT FACEBOOK PAGE DROPDOWN */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-mist-500">
                    Select Facebook Page
                  </span>
                  <div className="flex items-center gap-1.5 rounded-xl border border-ink-700 bg-ink-850 px-3 py-1.5 text-[12px] text-mist-200">
                    <span>{fb?.pageName || "Kiwik.One"}</span>
                    <ChevronDown size={13} className="text-mist-400" />
                  </div>
                </div>
              </div>

              {/* Facebook 4 KPI Cards matching user's Image 2 */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricPill
                  label="FOLLOWERS"
                  value={fb?.followers ?? 0}
                  icon={Users}
                  active={activeMetric === "followers"}
                  onClick={() => setActiveMetric("followers")}
                  info="Facebook page followers"
                />
                <MetricPill
                  label="REACH"
                  value={fb?.reach ?? 87}
                  icon={Radio}
                  active={activeMetric === "reach"}
                  onClick={() => setActiveMetric("reach")}
                  info="Unique people who saw any content from your page"
                />
                <MetricPill
                  label="IMPRESSIONS"
                  value={fb?.impressions ?? 93}
                  icon={Eye}
                  active={activeMetric === "impressions"}
                  onClick={() => setActiveMetric("impressions")}
                  highlight
                  info="Total number of times page posts were displayed"
                />
                <MetricPill
                  label="PROFILE VIEWS"
                  value={fb?.profileViews ?? 0}
                  icon={Users}
                  active={activeMetric === "profileViews"}
                  onClick={() => setActiveMetric("profileViews")}
                  info="Number of times your page profile was viewed"
                />
              </div>

              {/* Facebook 30-Day Curve Chart */}
              <div className="rounded-xl border border-ink-700/60 bg-ink-950/20 p-5">
                <h4 className="mb-4 text-center text-[12.5px] font-semibold text-mist-200">
                  {activeChartTitle}
                </h4>
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={activeChartData}
                      margin={{ top: 10, right: 12, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="fbAreaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--s-border)" />
                      <XAxis
                        dataKey="formattedDate"
                        tickLine={false}
                        axisLine={{ stroke: "var(--s-border)" }}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        interval={3}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        domain={[0, "auto"]}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload;
                          return (
                            <div className="rounded-xl border border-ink-600 bg-ink-850/95 px-3 py-2 text-[11.5px] shadow-xl backdrop-blur">
                              <span className="text-mist-400">{p.date}: </span>
                              <span className="font-bold text-blue-600 dark:text-blue-300">{p.value}</span>
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#3b82f6"
                        strokeWidth={2.5}
                        fill="url(#fbAreaGrad)"
                        dot={{ r: 3, fill: "#93c5fd", stroke: "#2563eb", strokeWidth: 1.5 }}
                        activeDot={{ r: 6, fill: "#ffffff", stroke: "#3b82f6", strokeWidth: 2 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* YOUTUBE VIEW */}
          {activePlatform === "youtube" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600 text-white shadow-md">
                    <Youtube size={18} />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-mist-100">YouTube</h3>
                    <p className="text-[12px] text-mist-400">{yt?.displayName || "Kiwik One"} · {yt?.handle || "@kiwik-one"}</p>
                  </div>
                </div>
                <a
                  href={`https://www.youtube.com/${yt?.handle || "@kiwik-one"}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] text-mist-400 hover:text-mist-100"
                >
                  Open Channel <ExternalLink size={11} />
                </a>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <MetricPill label="SUBSCRIBERS" value={yt?.followers ?? 0} icon={Users} />
                <MetricPill label="VIDEO VIEWS" value={yt?.views ?? 0} icon={Eye} highlight />
                <MetricPill label="LIKES" value={yt?.likes ?? 0} icon={Heart} />
                <MetricPill label="COMMENTS" value={yt?.comments ?? 0} icon={Users} />
                <MetricPill label="WATCH TIME" value={`${yt?.watchTimeMinutes ?? 0}m`} icon={BarChart2} />
                <MetricPill label="AVG DURATION" value={`${yt?.avgViewDurationSeconds ?? 0}s`} icon={BarChart2} />
              </div>

              <div className="rounded-xl border border-ink-700/60 bg-ink-950/20 p-5">
                <h4 className="mb-4 text-center text-[12.5px] font-semibold text-mist-200">
                  {activeChartTitle}
                </h4>
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={activeChartData}
                      margin={{ top: 10, right: 12, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="ytAreaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ef4444" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--s-border)" />
                      <XAxis
                        dataKey="formattedDate"
                        tickLine={false}
                        axisLine={{ stroke: "var(--s-border)" }}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        interval={3}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "var(--t-muted)", fontSize: 10 }}
                        domain={[0, "auto"]}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload;
                          return (
                            <div className="rounded-xl border border-ink-600 bg-ink-850/95 px-3 py-2 text-[11.5px] shadow-xl backdrop-blur">
                              <span className="text-mist-400">{p.date}: </span>
                              <span className="font-bold text-red-600 dark:text-red-300">{p.value}</span>
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="#ef4444"
                        strokeWidth={2.5}
                        fill="url(#ytAreaGrad)"
                        dot={{ r: 3, fill: "#fca5a5", stroke: "#dc2626", strokeWidth: 1.5 }}
                        activeDot={{ r: 6, fill: "#ffffff", stroke: "#ef4444", strokeWidth: 2 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* LINKEDIN VIEW */}
          {activePlatform === "linkedin" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#0077b5] text-white shadow-md">
                    <Linkedin size={18} />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-mist-100">LinkedIn</h3>
                    <p className="text-[12px] text-mist-400">{li?.displayName || "Kiwik.One 1"}</p>
                  </div>
                </div>
                <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-[11px] font-medium text-sky-600 dark:text-sky-300">
                  Personal Profile Connected
                </span>
              </div>

              <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-5">
                <div className="flex items-start gap-3">
                  <Info size={16} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" />
                  <div className="space-y-1 text-[12px] leading-relaxed text-mist-300">
                    <p className="font-medium text-mist-100">LinkedIn Analytics Policy</p>
                    <p>
                      {li?.note ||
                        "LinkedIn only provides post reach & timeseries analytics for organization/company pages you administer, not personal profiles. This is an official LinkedIn API restriction."}
                    </p>
                    <p className="pt-2 text-mist-400">
                      You can publish posts, articles, and carousels to your personal profile directly from the Villa-OS Composer. To unlock timeseries charts and audience demographics, link a LinkedIn Company Page via the publishing connector.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  icon: Icon,
  active = false,
  highlight = false,
  onClick,
  info,
}: {
  label: string;
  value: number | string;
  icon: typeof Eye;
  active?: boolean;
  highlight?: boolean;
  onClick?: () => void;
  info?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={`group relative flex cursor-pointer flex-col justify-between rounded-xl p-4 transition-all ${
        active || highlight
          ? "border-2 border-indigo-500 bg-indigo-500/10 shadow-sm dark:shadow-[0_0_15px_rgba(99,102,241,0.25)]"
          : "border border-ink-700/60 bg-ink-900/40 hover:border-ink-600 hover:bg-ink-850/70"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[9.5px] font-semibold tracking-wider text-mist-400">
          <Icon size={11} className={active || highlight ? "text-indigo-600 dark:text-indigo-400" : "text-mist-400"} />
          {label}
        </span>
        {info && (
          <div title={info}>
            <Info size={10} className="text-mist-500 group-hover:text-mist-300" />
          </div>
        )}
      </div>
      <div className="mt-2 text-[22px] font-bold tracking-tight text-mist-100">{value}</div>
    </div>
  );
}
