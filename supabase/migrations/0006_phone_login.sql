-- Phone number becomes the worker's login identity (mapped to
-- <phone>@staff.agamani.app under the hood), so it must be unique.
create unique index if not exists idx_profiles_phone_unique
  on profiles (phone) where phone is not null;
