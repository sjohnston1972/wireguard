# lambda/validate.py
#
# Plain English: lab 13's order check, the workflow's Lambda step. It takes
# the order from the EventBridge event's detail, refuses one whose quantity
# is not 1 or more (the workflow then ends Rejected), and returns the order
# with its total, which the workflow publishes to the topic.


def handler(event, _context):
    order = event.get("detail", event)
    qty = int(order.get("quantity", 0))
    price = float(order.get("price", 0))
    if qty <= 0:
        raise ValueError(f"order {order.get('orderId', '?')}: quantity must be 1 or more")
    return {"orderId": order.get("orderId", "unknown"), "quantity": qty, "price": price, "total": round(qty * price, 2), "valid": True}
