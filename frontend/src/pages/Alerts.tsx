import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { api, type Alert, type AlertRules } from "../api";
import { KIND_LABEL } from "../components/watch";
import { Card, Empty, ErrorBox, Skeleton, Switch } from "../components/ui";
import { ago, day } from "../format";

export function Alerts() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["alerts", "all"], queryFn: () => api.alerts(200) });
  const readAll = useMutation({
    mutationFn: () => api.markRead(),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "alerts" || x.queryKey[0] === "status" }),
  });

  return (
    <>
      <div className="page-head">
        <h1>Alerts</h1>
        <span className="muted">Checked after every data refresh.</span>
      </div>
      <div className="grid two-one">
        <Card
          title={`Recent${q.data?.unread ? ` · ${q.data.unread} unread` : ""}`}
          actions={
            <button className="btn" type="button" disabled={!q.data?.unread || readAll.isPending} onClick={() => readAll.mutate()}>
              Mark all read
            </button>
          }
        >
          {q.error ? (
            <ErrorBox error={q.error} />
          ) : !q.data ? (
            <Skeleton height={300} />
          ) : q.data.alerts.length === 0 ? (
            <Empty title="No alerts yet">
              <p>
                When a refresh finds new promoter trades that match your rules, they show up here (and on Telegram or
                email, if set up). Your existing history doesn't trigger alerts.
              </p>
            </Empty>
          ) : (
            <ul className="alert-list">
              {q.data.alerts.map((a) => (
                <AlertRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </Card>
        <RulesCard />
      </div>
    </>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const { search } = useLocation();
  return (
    <li className={a.read ? "" : "unread"}>
      <Link to={{ pathname: `/stock/${encodeURIComponent(a.symbol)}`, search }}>
        <span className={`chip ${a.kind === "cluster" ? "buy" : (a.direction ?? "neutral")}`}>{KIND_LABEL[a.kind]}</span>
        <span>
          <span className="alert-title">{a.title}</span>
          {a.detail && <span className="alert-detail muted">{a.detail}</span>}
        </span>
      </Link>
      <span className="faint alert-time" title={new Date(a.created_at).toLocaleString("en-IN")}>
        {a.event_date ? day(a.event_date, true) : ago(a.created_at)}
        {a.notified_at && " · sent"}
      </span>
    </li>
  );
}

const CRORE = 1e7;

function RulesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["alerts", "settings"], queryFn: api.alertSettings });
  const [rules, setRules] = useState<AlertRules | null>(null);
  useEffect(() => {
    if (q.data && !rules) setRules(q.data.rules);
  }, [q.data, rules]);
  const save = useMutation({
    mutationFn: (r: AlertRules) => api.saveAlertSettings(r),
    onSuccess: (data) => {
      qc.setQueryData(["alerts", "settings"], data);
      setRules(data.rules);
    },
  });
  const test = useMutation({ mutationFn: api.testAlert });

  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data || !rules) return <Skeleton height={380} />;
  const set = (patch: Partial<AlertRules>) => setRules({ ...rules, ...patch });
  const dirty = JSON.stringify(rules) !== JSON.stringify(q.data.rules);
  const ch = q.data.channels;

  return (
    <Card title="Rules">
      <form
        className="rules"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(rules);
        }}
      >
        <Switch
          label="Any promoter trade in a watched stock"
          checked={rules.watchlist_trades}
          onChange={(v) => set({ watchlist_trades: v })}
        />
        <div className="rule">
          <Switch
            label="High-conviction buy in any stock, score at least"
            checked={rules.min_conviction != null}
            onChange={(v) => set({ min_conviction: v ? 60 : null })}
          />
          {rules.min_conviction != null && (
            <input
              className="input num-input"
              type="number"
              min={0}
              max={100}
              aria-label="Minimum conviction score"
              value={rules.min_conviction}
              onChange={(e) => set({ min_conviction: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
            />
          )}
        </div>
        <Threshold
          label="Large buy in any stock, at least"
          value={rules.big_buy_value}
          onChange={(v) => set({ big_buy_value: v })}
          fallback={5 * CRORE}
        />
        <Threshold
          label="Large sell in any stock, at least"
          value={rules.big_sell_value}
          onChange={(v) => set({ big_sell_value: v })}
          fallback={25 * CRORE}
        />
        <div className="rule">
          <Switch
            label="Buying cluster"
            checked={rules.cluster_min_people != null}
            onChange={(v) => set({ cluster_min_people: v ? 3 : null })}
          />
          {rules.cluster_min_people != null && (
            <span className="rule-inputs muted">
              <select
                className="select"
                aria-label="Distinct promoters"
                value={rules.cluster_min_people}
                onChange={(e) => set({ cluster_min_people: Number(e.target.value) })}
              >
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}+ promoters
                  </option>
                ))}
              </select>
              within
              <select
                className="select"
                aria-label="Within days"
                value={rules.cluster_window_days}
                onChange={(e) => set({ cluster_window_days: Number(e.target.value) })}
              >
                {[7, 14, 30, 60, 90].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
        <Switch
          label="Open-market trades only (ignore gifts, pledges, ESOPs…)"
          checked={rules.market_only}
          onChange={(v) => set({ market_only: v })}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn primary" type="submit" disabled={!dirty || save.isPending}>
            Save rules
          </button>
          {save.isSuccess && !dirty && <span className="pos" style={{ fontSize: 12 }}>Saved</span>}
          {save.error && <span className="neg">{String(save.error.message)}</span>}
        </div>
      </form>

      <h2 style={{ marginTop: 24, marginBottom: 8 }}>Delivery</h2>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>
        Alerts always appear here. To also get them as one message per refresh:
      </p>
      <ul className="channels">
        <li>
          <span className={`chip ${ch.telegram ? "buy" : "neutral"}`}>{ch.telegram ? "on" : "off"}</span> Telegram
        </li>
        <li>
          <span className={`chip ${ch.email ? "buy" : "neutral"}`}>{ch.email ? "on" : "off"}</span> Email
        </li>
      </ul>
      {ch.telegram || ch.email ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button className="btn" type="button" disabled={test.isPending} onClick={() => test.mutate()}>
            Send a test alert
          </button>
          {test.data && (
            <span className={test.data.errors.length ? "neg" : "pos"} style={{ fontSize: 12 }}>
              {test.data.errors.length ? test.data.errors.join("; ") : `Sent by ${test.data.sent.join(" and ")}`}
            </span>
          )}
          {test.error && <span className="neg" style={{ fontSize: 12 }}>{test.error.message}</span>}
        </div>
      ) : (
        <p className="card-note">
          Set <code>PROMOTER_TELEGRAM_BOT_TOKEN</code> and <code>PROMOTER_TELEGRAM_CHAT_ID</code>, or the{" "}
          <code>PROMOTER_SMTP_*</code> and <code>PROMOTER_ALERT_EMAIL_TO</code> variables, then restart the server. The
          README explains each.
        </p>
      )}
    </Card>
  );
}

function Threshold(props: { label: string; value: number | null; onChange: (v: number | null) => void; fallback: number }) {
  const on = props.value != null;
  return (
    <div className="rule">
      <Switch label={props.label} checked={on} onChange={(v) => props.onChange(v ? props.fallback : null)} />
      {on && (
        <span className="rule-inputs">
          <span className="mono muted">₹</span>
          <input
            className="input num-input"
            type="number"
            min={0}
            step={0.5}
            aria-label={`${props.label} (₹ crore)`}
            value={props.value! / CRORE}
            onChange={(e) => props.onChange(Math.max(0, Number(e.target.value) || 0) * CRORE)}
          />
          <span className="mono muted">cr</span>
        </span>
      )}
    </div>
  );
}
