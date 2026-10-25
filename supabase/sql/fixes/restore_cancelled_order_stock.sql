-- Cancellation and inventory restoration are atomic; cancelled orders cannot reopen.
create or replace function public.restore_stock_on_order_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requirement record;
begin
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'Un pedido cancelado no puede reabrirse. Creá un pedido nuevo.';
  end if;
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;
  if new.items is distinct from old.items then
    raise exception 'No se pueden modificar los productos al cancelar un pedido';
  end if;
  for requirement in
    with order_items as (
      select
        (element.value->>'id')::bigint as product_id,
        nullif(element.value->>'size', '') as size,
        (element.value->>'quantity')::integer as quantity
      from jsonb_array_elements(old.items) as element(value)
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
    update public.products
    set stock = stock + requirement.quantity,
        size_stock = case when requirement.size is not null then
          jsonb_set(coalesce(size_stock, '{}'::jsonb), array[requirement.size],
            to_jsonb(coalesce((size_stock->>requirement.size)::integer, 0) + requirement.quantity), true)
          else size_stock end,
        updated_at = now()
    where id = requirement.product_id and product_type <> 'composite';
    if not found then
      raise exception 'No se pudo devolver stock al producto %', requirement.product_id;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.restore_stock_on_order_cancellation() from public, anon, authenticated;
drop trigger if exists restore_stock_on_order_cancellation on public.orders;
create trigger restore_stock_on_order_cancellation
before update of status on public.orders
for each row execute function public.restore_stock_on_order_cancellation();
