-- edge-writer v2.9 마이그레이션 (집필기법 v2.0 반영)
-- Supabase → SQL Editor에 붙여넣고 Run. 여러 번 실행해도 안전하다.
--
-- 1. 감수 종류에 배우(baeu)와 독자(dokja)를 추가한다.
--    v2.8에서 배우를 앱에 넣으면서 enum을 늘리지 않아, 배우 리포트의 클라우드 저장이 실패하고 있었다.
alter type review_kind add value if not exists 'baeu';
alter type review_kind add value if not exists 'dokja';

-- 2. 문서 '전체줄거리(outline)'는 documents.slug에 제약이 없으므로 별도 작업이 필요 없다.
--    앱에서 작품 문서를 한 번 저장하면 행이 생긴다.
--    (v2.8의 migrate-v2.8.sql은 work_id 없이 insert해서 실패했을 수 있다. 무시해도 된다 —
--     v2.9 앱이 craft·canon·outline 행을 제목과 함께 만든다.)
