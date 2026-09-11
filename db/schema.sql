-- ═══════════════════════════════════════════════════════════
-- edge writer — Supabase 스키마 v2.0 (작품 다중 지원)
-- 2026-09-11
--
-- v1.0에서 바뀐 것: 모든 테이블이 work_id로 묶인다.
-- 엣지라이트는 작품 서재 구조라 『최약체 회귀병사』와 『패수』가 공존한다.
-- v1.0은 작품 하나를 전제해 episodes(part, no)에 유니크를 걸었고,
-- 그 상태로는 두 작품의 1부 1화가 충돌한다.
--
-- 실행: Supabase 대시보드 → SQL Editor → 붙여넣기 → Run
-- 여러 번 실행해도 안전하다.
--
-- v1.0을 이미 실행했다면 아래 주석을 풀고 한 번만 돌린 뒤 이어서 실행한다:
-- drop view if exists v_progress, v_distribution, v_timeline, v_neglected,
--   v_appearances, v_plant_load, v_open_plants, v_blocking_findings cascade;
-- drop table if exists backups, setting_entries, plant_events, plants, reviews,
--   episode_versions, episodes, document_versions, documents cascade;
-- drop type if exists episode_status, review_kind, plant_action cascade;
-- ═══════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ───────────────────────────────────────────────────────────
-- 0. 작품 — 모든 것의 뿌리
-- ───────────────────────────────────────────────────────────

create table if not exists works (
  id          text primary key,            -- 'paesu', 'choiyakche-v1' (기존 localStorage id 그대로)
  title       text not null,
  genre       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table works is '엣지라이트 작품 서재. id는 기존 localStorage의 work.id를 그대로 옮긴다.';


-- ───────────────────────────────────────────────────────────
-- 1. 문서 — 작품당 6종
-- ───────────────────────────────────────────────────────────

create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  work_id     text not null references works(id) on delete cascade,
  slug        text not null,               -- plan | world | characters | roadmap | schema | ledger
  title       text not null,
  content     text not null default '',
  version     int  not null default 1,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (work_id, slug)
);

comment on column documents.slug is '앱의 work.docs 키와 1:1. schema/ledger가 v2에서 추가된 5·6번 필드.';

create table if not exists document_versions (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version     int  not null,
  content     text not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (document_id, version)
);

create index if not exists idx_docver on document_versions(document_id, version desc);

create or replace function fn_document_snapshot() returns trigger as $$
begin
  if new.content is distinct from old.content then
    insert into document_versions(document_id, version, content)
    values (old.id, old.version, old.content);
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_document_snapshot on documents;
create trigger trg_document_snapshot
  before update on documents
  for each row execute function fn_document_snapshot();


-- ───────────────────────────────────────────────────────────
-- 2. 회차 — 확정 원고가 사는 곳
-- ───────────────────────────────────────────────────────────

do $$ begin
  create type episode_status as enum ('draft', 'review', 'confirmed', 'published');
exception when duplicate_object then null; end $$;

create table if not exists episodes (
  id            uuid primary key default gen_random_uuid(),
  work_id       text not null references works(id) on delete cascade,

  part          int  not null default 1 check (part between 1 and 20),
  no            int  not null check (no > 0),
  label         text not null,               -- '1부-003' 또는 앱의 episodeLabel 원문
  title         text not null default '',

  body          text not null default '',
  meta_raw      text,
  meta          jsonb not null default '{}',

  char_count    int generated always as (length(body)) stored,
  char_count_ns int,                          -- 공백 제외 (앱이 계산해 넣는다)

  status        episode_status not null default 'draft',
  confirmed_at  timestamptz,
  published_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (work_id, part, no)
);

comment on column episodes.confirmed_at is '최종 감수 통과 시각. 이 값이 있으면 확정 원고다.';

create index if not exists idx_ep_work   on episodes(work_id, part, no);
create index if not exists idx_ep_status on episodes(work_id, status);
create index if not exists idx_ep_meta   on episodes using gin (meta);

create table if not exists episode_versions (
  id            uuid primary key default gen_random_uuid(),
  episode_id    uuid not null references episodes(id) on delete cascade,
  version       int  not null,
  body          text not null,
  meta_raw      text,
  char_count    int,
  note          text,
  was_confirmed boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (episode_id, version)
);

create index if not exists idx_epver on episode_versions(episode_id, version desc);

create or replace function fn_episode_snapshot() returns trigger as $$
declare v int;
begin
  if new.body is distinct from old.body then
    select coalesce(max(version), 0) + 1 into v
      from episode_versions where episode_id = old.id;
    insert into episode_versions(episode_id, version, body, meta_raw, char_count, was_confirmed)
    values (old.id, v, old.body, old.meta_raw, old.char_count, old.confirmed_at is not null);
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_episode_snapshot on episodes;
create trigger trg_episode_snapshot
  before update on episodes
  for each row execute function fn_episode_snapshot();


-- ───────────────────────────────────────────────────────────
-- 3. 감수 — 감(설정) / 어사(수위·법무) / 도목수(구조)
-- ───────────────────────────────────────────────────────────

do $$ begin
  create type review_kind as enum ('gam', 'eosa', 'domoksu');
exception when duplicate_object then null; end $$;

create table if not exists reviews (
  id          uuid primary key default gen_random_uuid(),
  work_id     text not null references works(id) on delete cascade,
  episode_id  uuid not null references episodes(id) on delete cascade,
  kind        review_kind not null default 'gam',
  round       int  not null default 1,
  score       int  check (score between 0 and 100),
  verdict     text check (verdict in ('pass', 'revise')),
  report      jsonb not null default '{}',   -- 앱의 report JSON 전체를 그대로
  created_at  timestamptz not null default now(),
  unique (episode_id, kind, round)
);

comment on table reviews is '감수는 자문이다. verdict가 revise여도 대표가 확정할 수 있다 (기획안 6항).';

create index if not exists idx_review on reviews(episode_id, created_at desc);

-- 고·중 심각도가 남은 회차 — 공개 기준 위반 목록
create or replace view v_blocking as
select
  e.work_id, e.part, e.no, e.label, r.kind, r.round,
  f->>'심각도' as severity,
  f->>'지적'   as issue
from reviews r
join episodes e on e.id = r.episode_id
cross join lateral (
  select jsonb_array_elements(coalesce(r.report->'설정오류','[]'::jsonb))   as f
  union all
  select jsonb_array_elements(coalesce(r.report->'인물불일치','[]'::jsonb))
  union all
  select jsonb_array_elements(coalesce(r.report->'문체지적','[]'::jsonb))
) x
where f->>'심각도' in ('높음','중간')
  and e.status <> 'published';


-- ───────────────────────────────────────────────────────────
-- 4. 떡밥
-- ───────────────────────────────────────────────────────────

do $$ begin
  create type plant_action as enum ('planted','reinforced','held','resolved','dropped');
exception when duplicate_object then null; end $$;

create table if not exists plants (
  code          text not null,               -- T001 ... 작품 안에서 영구 불변
  work_id       text not null references works(id) on delete cascade,
  name          text not null,
  description   text,
  planted_part  int,
  planted_no    int,
  status        plant_action not null default 'planted',
  due_part      int,
  due_no        int,
  resolved_part int,
  resolved_no   int,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (work_id, code)
);

create table if not exists plant_events (
  id          uuid primary key default gen_random_uuid(),
  work_id     text not null,
  code        text not null,
  episode_id  uuid references episodes(id) on delete set null,
  action      plant_action not null,
  note        text,
  created_at  timestamptz not null default now(),
  foreign key (work_id, code) references plants(work_id, code) on delete cascade
);

create index if not exists idx_plantev on plant_events(work_id, code, created_at);

create or replace view v_open_plants as
select
  p.work_id, p.code, p.name, p.status,
  p.planted_part, p.planted_no, p.due_part, p.due_no,
  case
    when p.due_part is null then '예정 미정'
    when p.due_no is not null and exists (
      select 1 from episodes e
      where e.work_id = p.work_id and e.part = p.due_part
        and e.no > p.due_no and e.status = 'published'
    ) then '지연'
    else '정상'
  end as alert
from plants p
where p.status not in ('resolved','dropped');

-- 부별 회수 부담 — 중반부가 비어 있는지 보는 용도
create or replace view v_plant_load as
select w.id as work_id, g.part,
       count(p.code) filter (where p.status not in ('resolved','dropped')) as open_due
from works w
cross join generate_series(1,8) as g(part)
left join plants p on p.work_id = w.id and p.due_part = g.part
group by w.id, g.part
order by w.id, g.part;


-- ───────────────────────────────────────────────────────────
-- 5. 설정 신규 항목 — 메타 블록에서 자동 수집
-- ───────────────────────────────────────────────────────────

create table if not exists setting_entries (
  id          uuid primary key default gen_random_uuid(),
  work_id     text not null references works(id) on delete cascade,
  key         text not null,
  category    text,
  content     text not null,
  source_part int,
  source_no   int,
  registered  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (work_id, key)
);

comment on column setting_entries.registered is 'false면 설정집에 아직 반영 안 된 것. 다음 감수 전에 비워야 한다.';


-- ───────────────────────────────────────────────────────────
-- 6. 백업 로그 — 구글드라이브 이중화
-- ───────────────────────────────────────────────────────────

create table if not exists backups (
  id            uuid primary key default gen_random_uuid(),
  work_id       text references works(id) on delete set null,
  target_type   text not null check (target_type in ('episode','document','full')),
  target_id     uuid,
  drive_file_id text,
  drive_path    text,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_backup on backups(work_id, target_type, created_at desc);


-- ───────────────────────────────────────────────────────────
-- 7. 파생 뷰
-- ───────────────────────────────────────────────────────────

create or replace view v_appearances as
select e.work_id, e.part, e.no, e.label, e.status,
       r.role_key as role,
       trim(both '"' from name::text) as character
from episodes e
cross join lateral (values ('주역'),('조연'),('언급')) as r(role_key)
cross join lateral jsonb_array_elements(
  coalesce(e.meta->'등장'->r.role_key, '[]'::jsonb)) as name;

-- 주역인데 5화 이상 안 나온 인물 — 군상극 방치 경보
create or replace view v_neglected as
with last_seen as (
  select work_id, character, max(part*1000+no) as last_pos
  from v_appearances where role = '주역' group by work_id, character
), cur as (
  select work_id, coalesce(max(part*1000+no),0) as pos from episodes group by work_id
)
select l.work_id, l.character, l.last_pos, c.pos as current_pos,
       (c.pos - l.last_pos) as gap
from last_seen l join cur c on c.work_id = l.work_id
where (c.pos - l.last_pos) >= 5
order by gap desc;

create or replace view v_timeline as
select work_id, part, no, label, title, meta->>'시기' as period, status
from episodes order by work_id, part, no;

-- 수위로 낭독·영상 가능 회차 분류
create or replace view v_distribution as
select work_id, part, no, label,
       meta->'수위'->>'유형' as flags,
       case
         when (meta->'수위'->>'유형') like '%성애-직접%' then '낭독 불가'
         when (meta->'수위'->>'유형') like '%성애-간접%' then '편집 필요'
         else '가능'
       end as audio_ok
from episodes
where status in ('confirmed','published')
order by work_id, part, no;

-- 집필 현황 + 문피아 일반연재 승급까지 남은 글자수
create or replace view v_progress as
select
  w.id as work_id, w.title,
  count(e.id)                                        as total,
  count(e.id) filter (where e.status = 'confirmed')  as confirmed,
  count(e.id) filter (where e.status = 'published')  as published,
  coalesce(sum(e.char_count) filter (where e.status in ('confirmed','published')),0) as confirmed_chars,
  greatest(75000 - coalesce(sum(e.char_count) filter (where e.status in ('confirmed','published')),0), 0) as chars_to_promotion
from works w left join episodes e on e.work_id = w.id
group by w.id, w.title;


-- ───────────────────────────────────────────────────────────
-- 8. 보안 — RLS
-- ───────────────────────────────────────────────────────────
-- 단일 사용자라도 반드시 켠다. anon 키는 브라우저에 노출되기 때문이다.

do $$
declare t text;
begin
  foreach t in array array['works','documents','document_versions','episodes',
                           'episode_versions','reviews','plants','plant_events',
                           'setting_entries','backups']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_auth', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t||'_auth', t);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────
-- 9. 작품 등록 + 문서 6칸 자동 생성
-- ───────────────────────────────────────────────────────────

create or replace function fn_seed_documents() returns trigger as $$
begin
  insert into documents (work_id, slug, title) values
    (new.id, 'plan',       '기획안'),
    (new.id, 'world',      '설정집'),
    (new.id, 'characters', '인물집'),
    (new.id, 'roadmap',    '로드맵'),
    (new.id, 'schema',     '메타스키마'),
    (new.id, 'ledger',     '떡밥장부')
  on conflict (work_id, slug) do nothing;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_seed_documents on works;
create trigger trg_seed_documents
  after insert on works
  for each row execute function fn_seed_documents();

-- 작품 둘 등록 (문서 6칸은 트리거가 자동 생성)
insert into works (id, title, genre) values
  ('paesu', '패수', '대체역사 (문피아) · 19세 · 주5회 · 회당 5,500~6,500자(공백 포함)'),
  ('choiyakche-v1', '최약체 회귀병사', '회귀 / 밀리터리 퓨전 판타지 (문피아·조아라, 주5회, 회당 5,000~5,500자)')
on conflict (id) do nothing;
