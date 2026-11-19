BEGIN;
CREATE TABLE sharkai_broker.registration_plan (
  user_id text PRIMARY KEY REFERENCES public."User"(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK(plan IN ('FREE','PRO','ULTRA'))
);
ALTER TABLE sharkai_broker.registration_plan ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION sharkai_broker.capture_registration_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $capture$
BEGIN
  INSERT INTO sharkai_broker.registration_plan(user_id,plan) VALUES(NEW.id,NEW.plan::text);
  RETURN NEW;
END $capture$;
CREATE TRIGGER capture_shark_registration_plan AFTER INSERT ON public."User"
FOR EACH ROW EXECUTE FUNCTION sharkai_broker.capture_registration_plan();
CREATE INDEX IF NOT EXISTS "User_signup_report_created_id_idx" ON public."User"("createdAt" DESC,id DESC);

CREATE FUNCTION sharkai_broker.admin_fee_dashboard(p_admin text,p_start date,p_end date,p_page integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $report$
WITH authorized AS (
  SELECT 1 FROM public."User" WHERE id=p_admin AND role::text='ADMIN' AND p_page>=1 AND p_end>=p_start
), bounds AS (
  SELECT p_start::timestamp AT TIME ZONE 'Europe/Sofia' AS begin_at,(p_end+1)::timestamp AT TIME ZONE 'Europe/Sofia' AS end_at FROM authorized
), registered AS (
  SELECT u.id,u.plan::text AS plan FROM public."User" u,bounds b
  WHERE lower(u.email)<>'guest@sharkai.local' AND u."createdAt">=(b.begin_at AT TIME ZONE 'UTC') AND u."createdAt"<(b.end_at AT TIME ZONE 'UTC')
), member_page AS (
  SELECT u.id,u.email,u.name,u.plan::text AS plan,s.plan AS "signupPlan",
    to_char(u."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
  FROM registered r JOIN public."User" u ON u.id=r.id LEFT JOIN sharkai_broker.registration_plan s ON s.user_id=u.id
  ORDER BY u."createdAt" DESC,u.id DESC LIMIT 20 OFFSET ((greatest(p_page,1)::bigint-1)*20)
), classified AS (
  SELECT f.currency,f.fee_minor,f.credited_at IS NULL AS unpaid,(f.ends_on-1 BETWEEN p_start AND p_end) AS earned,
    (f.credited_at>=b.begin_at AND f.credited_at<b.end_at) AS paid,(f.reversed_at>=b.begin_at AND f.reversed_at<b.end_at) AS reversed
  FROM sharkai_broker.performance_fee_period f,bounds b WHERE f.beneficiary_user_id=p_admin
  AND (f.ends_on-1 BETWEEN p_start AND p_end OR f.credited_at>=b.begin_at AND f.credited_at<b.end_at
    OR f.reversed_at>=b.begin_at AND f.reversed_at<b.end_at)
), amounts AS (
  SELECT currency,coalesce(sum(fee_minor) FILTER(WHERE earned),0) AS earned,coalesce(sum(fee_minor) FILTER(WHERE earned AND unpaid),0) AS accrued,
    coalesce(sum(fee_minor) FILTER(WHERE paid),0) AS received,coalesce(sum(fee_minor) FILTER(WHERE reversed),0) AS refunds FROM classified GROUP BY currency
)
SELECT jsonb_build_object('status','available','from',p_start,'to',p_end,'timezone','Europe/Sofia','page',p_page,'pageSize',20,
  'totalRegistrations',(SELECT count(*) FROM registered),'hasMore',(SELECT count(*)>p_page::bigint*20 FROM registered),
  'members',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."createdAt" DESC,m.id DESC) FROM member_page m),'[]'::jsonb),
  'registrations',(SELECT jsonb_agg(jsonb_build_object('plan',p.name,'count',(SELECT count(*) FROM registered r WHERE r.plan=p.name)) ORDER BY p.ord)
    FROM unnest(ARRAY['FREE','PRO','ULTRA']) WITH ORDINALITY p(name,ord)),
  'currencies',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'earned_minor',earned::text,
    'accrued_minor',accrued::text,'credited_minor',received::text,'reversed_minor',refunds::text,'net_received_minor',(received-refunds)::text)
    ORDER BY currency) FROM amounts),'[]'::jsonb))
FROM authorized
$report$;
REVOKE ALL ON sharkai_broker.registration_plan FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION sharkai_broker.capture_registration_plan(),sharkai_broker.admin_fee_dashboard(text,date,date,integer)
  FROM PUBLIC,anon,authenticated;
COMMIT;
