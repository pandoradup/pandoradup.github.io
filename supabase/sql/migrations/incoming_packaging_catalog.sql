create or replace function public.resolve_incoming_item(p_id uuid, p_receive boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  item public.incoming_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Acceso restringido';
  end if;

  select * into item from public.incoming_items where id = p_id for update;
  if not found or item.status <> 'pending' then
    raise exception 'El artículo ya fue procesado o no existe';
  end if;

  if p_receive then
    update public.products
    set stock = case when item.size is null then stock else
          (select coalesce(sum(value::integer), 0) from jsonb_each_text(size_stock))
        end + item.quantity,
        size_stock = case when item.size is null then size_stock else
          jsonb_set(size_stock, array[item.size],
            to_jsonb(coalesce((size_stock->>item.size)::integer, 0) + item.quantity))
        end,
        updated_at = now()
    where id = item.product_id
      and ((product_type = 'base' and item.size in ('17 cm','18 cm','19 cm','20 cm'))
        or ((product_type = 'charm' or (product_type = 'simple' and category = 'packaging'))
          and item.size is null));
    if not found then
      raise exception 'El tipo de producto o el talle ya no coincide';
    end if;
  end if;

  update public.incoming_items
  set status = case when p_receive then 'received' else 'cancelled' end
  where id = p_id;
end;
$$;

