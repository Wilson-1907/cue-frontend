(function ($) {
    "use strict";

    // Spinner — always clear the white overlay
    var spinner = function () {
        setTimeout(function () {
            if ($('#spinner').length > 0) {
                $('#spinner').removeClass('show');
            }
        }, 1);
    };
    spinner();

    // Fallback if jQuery plugins fail to load
    window.addEventListener('load', function () {
        var el = document.getElementById('spinner');
        if (el) el.classList.remove('show');
    });

    try {
        if (typeof WOW !== 'undefined') new WOW().init();
    } catch (e) { /* ignore */ }

    $(window).scroll(function () {
        if ($(this).scrollTop() > 45) {
            $('.navbar').addClass('sticky-top shadow-sm');
        } else {
            $('.navbar').removeClass('sticky-top shadow-sm');
        }
    });

    try {
        if ($.fn.owlCarousel && $(".testimonial-carousel").length) {
            $(".testimonial-carousel").owlCarousel({
                autoplay: true,
                smartSpeed: 1500,
                center: false,
                dots: true,
                loop: true,
                margin: 25,
                nav: true,
                navText: [
                    '<i class="fa fa-angle-right"></i>',
                    '<i class="fa fa-angle-left"></i>'
                ],
                responsiveClass: true,
                responsive: {
                    0: { items: 1 },
                    576: { items: 1 },
                    768: { items: 1 },
                    992: { items: 2 },
                    1200: { items: 2 }
                }
            });
        }
    } catch (e) { /* ignore */ }

    try {
        if ($.fn.counterUp) {
            $('[data-toggle="counter-up"]').counterUp({
                delay: 5,
                time: 2000
            });
        }
    } catch (e) { /* ignore */ }

    $(window).scroll(function () {
        if ($(this).scrollTop() > 300) {
            $('.back-to-top').fadeIn('slow');
        } else {
            $('.back-to-top').fadeOut('slow');
        }
    });
    $('.back-to-top').click(function () {
        $('html, body').animate({ scrollTop: 0 }, 1500, 'easeInOutExpo');
        return false;
    });
})(jQuery);
