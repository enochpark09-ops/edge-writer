-- edge-writer v2.8 마이그레이션
-- 문서 2종 추가: 집필기법(craft), 고증바이블(canon)
-- documents.slug 에는 CHECK 제약이 없으므로 행만 추가하면 된다.

insert into documents (slug, title) values
  ('craft', '집필기법'),
  ('canon', '고증바이블')
on conflict (slug) do nothing;
