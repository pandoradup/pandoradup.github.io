-- Reserve total and size-specific stock on INSERT, including pending orders.
-- Atomic guarded updates prevent overselling and rollback the entire order on failure.
create or replace function public.validate_cart_stock(p_items jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  item jsonb;
  item_id bigint;
  item_quantity integer;
  item_size text;
  ordered_type text;
  ordered_category text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return false; end if;
  if jsonb_array_length(p_items) = 0 then return false; end if;
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    item_id := (item->>'id')::bigint;
    item_quantity := (item->>'quantity')::integer;
    item_size := nullif(item->>'size', '');
    select product_type, category into ordered_type, ordered_category from public.products where id = item_id and published = true;
    if ordered_type is null or item_quantity is null or item_quantity <= 0 then return false; end if;
    if (ordered_type in ('base', 'composite') or ordered_category = 'brazaletes') and item_size is null then return false; end if;
    if ordered_type = 'composite' and not exists (
      select 1 from public.product_components where composite_product_id = item_id
    ) then return false; end if;
  end loop;
  return not exists (
    with order_items as (
      select
        (entry->>'id')::bigint product_id,
        nullif(entry->>'size', '') size,
        (entry->>'quantity')::integer quantity
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) entry
    ), physical_requirements as (
      select
        ordered.id product_id,
        case when ordered.product_type = 'base' or ordered.category = 'brazaletes' then order_items.size else null end size,
        order_items.quantity
      from order_items join public.products ordered on ordered.id = order_items.product_id
      where ordered.product_type <> 'composite'
      union all
      select
        recipe.component_product_id,
        case when component.product_type = 'base' or component.category = 'brazaletes' then order_items.size else null end size,
        order_items.quantity * recipe.quantity
      from order_items
      join public.products ordered on ordered.id = order_items.product_id
      join public.product_components recipe on recipe.composite_product_id = ordered.id
      join public.products component on component.id = recipe.component_product_id
      where ordered.product_type = 'composite'
    ), totals as (
      select product_id, size, sum(quantity)::integer quantity
      from physical_requirements group by product_id, size
    )
    select 1
    from totals
    join public.products component on component.id = totals.product_id
    where component.product_type = 'composite'
       or (
        totals.size is not null
        and coalesce((component.size_stock->>totals.size)::integer, 0) < totals.quantity
      )
       or component.stock < (select sum(t.quantity) from totals t where t.product_id = totals.product_id)
  );
end;
$$;

revoke all on function public.validate_cart_stock(jsonb) from public;
grant execute on function public.validate_cart_stock(jsonb) to anon, authenticated;


create or replace function public.decrease_stock_for_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_item jsonb;
  item_id bigint;
  item_quantity integer;
  item_size text;
  ordered_type text;
  ordered_category text;
  requirement record;
begin
  if new.items is null or jsonb_typeof(new.items) <> 'array' then
    raise exception 'El pedido debe contener productos';
  end if;
  if jsonb_array_length(new.items) = 0 then
    raise exception 'El pedido debe contener productos';
  end if;
  for order_item in
    select element.value
    from jsonb_array_elements(new.items) as element(value)
  loop
    item_id := (order_item->>'id')::bigint;
    item_quantity := (order_item->>'quantity')::integer;
    item_size := nullif(order_item->>'size', '');
    if item_quantity is null or item_quantity <= 0 then
      raise exception 'Cantidad inválida para el producto %', item_id;
    end if;
    select product_type, category into ordered_type, ordered_category from public.products where id = item_id and published = true;
    if ordered_type is null then
      raise exception 'Producto inexistente: %', item_id;
    end if;
    if (ordered_type in ('base', 'composite') or ordered_category = 'brazaletes') and item_size is null then
      raise exception 'Falta talle para el producto %', item_id;
    end if;
    if ordered_type = 'composite' and not exists (
      select 1 from public.product_components where composite_product_id = item_id
    ) then
      raise exception 'El producto compuesto % no tiene componentes', item_id;
    end if;
  end loop;

  for requirement in
    with order_items as (
      select
        (element.value->>'id')::bigint as product_id,
        nullif(element.value->>'size', '') as size,
        (element.value->>'quantity')::integer as quantity
      from jsonb_array_elements(new.items) as element(value)
    ),
    physical_requirements as (
      select
        ordered.id as product_id,
        case when ordered.product_type = 'base' or ordered.category = 'brazaletes' then order_items.size else null end as size,
        order_items.quantity as quantity
      from order_items
      join public.products ordered on ordered.id = order_items.product_id
      where ordered.product_type <> 'composite'
      union all
      select
        recipe.component_product_id,
        case when component.product_type = 'base' or component.category = 'brazaletes' then order_items.size else null end as size,
        order_items.quantity * recipe.quantity
      from order_items
      join public.products ordered on ordered.id = order_items.product_id
      join public.product_components recipe on recipe.composite_product_id = ordered.id
      join public.products component on component.id = recipe.component_product_id
      where ordered.product_type = 'composite'
    )
    select physical_requirements.product_id, physical_requirements.size, sum(physical_requirements.quantity)::integer as quantity
    from physical_requirements
    group by physical_requirements.product_id, physical_requirements.size
    order by physical_requirements.product_id, physical_requirements.size nulls first
  loop
    if requirement.size is not null then
      update public.products
      set size_stock = jsonb_set(
            size_stock,
            array[requirement.size],
            to_jsonb(((size_stock->>requirement.size)::integer - requirement.quantity)),
            true
          ),
          stock = stock - requirement.quantity,
          updated_at = now()
      where id = requirement.product_id
        and product_type <> 'composite'
        and coalesce((size_stock->>requirement.size)::integer, 0) >= requirement.quantity
        and stock >= requirement.quantity;
    else
      update public.products
      set stock = stock - requirement.quantity,
          updated_at = now()
      where id = requirement.product_id
        and product_type <> 'composite'
        and stock >= requirement.quantity;
    end if;
    if not found then
      raise exception 'Stock insuficiente para el producto %', requirement.product_id;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists decrease_stock_after_order on public.orders;
create trigger decrease_stock_after_order
before insert on public.orders
for each row execute function public.decrease_stock_for_order();

revoke all on function public.decrease_stock_for_order() from public, anon, authenticated;
