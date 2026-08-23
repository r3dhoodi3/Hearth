-- Delete 24 test/junk contractor rows from the live DB (approved by Landen 2026-08-21).
-- Matched by id prefix AND exact name so a typo cannot hit a real company.
-- Cascades remove their leads, chats, wallet rows. Keeps the 6 June-3 demo seeds,
-- "Wills Business", "2e3thyj" (Landen), and the audit persona "Luis Plumbing Co"
-- (removed separately with the audit accounts).
begin;

with targets(prefix, name) as (values
  ('e0bf7e14', 'Contractor #1'),
  ('3f4a33d9', 'you da real company'),
  ('5256a0c1', 'Roofing Pro.co'),
  ('1dd24796', 'Landen''s BJ service'),
  ('e561a5c5', 'Company name placceholder'),
  ('a6099d74', 'landen cock sucking'),
  ('79094247', 'Landen''s BJ service pt2'),
  ('c089d2ea', 'BBL'),
  ('a1cce70c', 'phong '),
  ('5c6e20b3', 'QA Test Contracting LLC'),
  ('66df9cf4', 'Ace Roofing Test Co'),
  ('09455f2e', 'QA Test Contracting LLC 🛠️'),
  ('366100f1', 'Ace Repairs & Co. <script>x</script>'),
  ('32c473bd', 'Ace Fix-It Co "Handy" & <Sons>'),
  ('d31f4b49', 'Chaos Contracting LLC'),
  ('87bb9548', 'HS Test Roofing Co'),
  ('03923d85', 'HS Test Roofing Co 2'),
  ('67e0476b', 'HS Delete Test Co'),
  ('9741561e', 'HS Delete Test Co'),
  ('c0ebe962', 'QA Test Contracting LLC'),
  ('407d4a43', 'Landen sux bawls'),
  ('b6cba5c0', 'sgq'),
  ('21c887c1', 'Attacker Plumbing Co (redteam test)'),
  ('58abeffc', 'RT Guarantee Pro Co (rebuilt)')
)
delete from public.contractors c
using targets t
where left(c.id::text, 8) = t.prefix and c.name = t.name;

-- Expect: DELETE 24. Then this should list 9 rows.
select left(id::text, 8) as id, name, created_at::date from public.contractors order by created_at;

commit;
